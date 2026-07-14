// src/routes/event-flow.factory.js
import { Router } from 'express';
import assert from 'node:assert/strict';
import mongoose, { isValidObjectId } from 'mongoose';

import { Event } from '../models/Event.js';
import { Seat } from '../models/Seat.js';
import { SeatHold } from '../models/SeatHold.js';
import { Order } from '../models/Order.js';
import { Tariff } from '../models/Tariff.js';
import { TariffPrice } from '../models/TariffPrice.js';
import { Zone } from '../models/Zone.js';
import { createCheckoutIntent, buildReturnUrls, currentPaymentProviderId, currentPaymentUxMode } from '../services/payments/index.js';
import { resolveLinePlacement } from '../utils/event-attendance.js';
import { finalizePaidIfNoConflict, sendOrderAttestationIfNeeded } from '../services/order-finalization.js';
import { matchesChannel } from '../utils/channel-scopes.js';
import { filterTariffsAndPricesByChannel } from '../utils/tariff-filter.js';

const PAYMENT_PROVIDER_ID = currentPaymentProviderId();
const HOLD_MIN = Number(process.env.CHECKOUT_HOLD_MIN || '5');
const SEAT_HOLD_TTL_MIN = Number(process.env.SEAT_HOLD_TTL_MIN || '3');

function buildPayStartUrl(orderId) {
  // APP_URL already contains BASE_PATH in deployed envs (same as SUMUP_RETURN_URL convention)
  const app = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return `${app}/pay/start?orderId=${encodeURIComponent(String(orderId))}`;
}

function buildPayStatusUrl(orderId) {
  const app = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return `${app}/pay/status?orderId=${encodeURIComponent(String(orderId))}`;
}

function buildPayReturnUrl(orderId, checkoutId) {
  const app = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const oid = encodeURIComponent(String(orderId));
  const ci  = checkoutId ? `&ci=${encodeURIComponent(String(checkoutId))}` : '';
  return `${app}/pay/return?oid=${oid}${ci}`;
}

// Helper: reconnaît un ID virtuel de zone (ex: DEBOUT-Z001)
const isVirtualZoneSeatId = (sid) => /^.+-Z\d{3,}$/i.test(String(sid || ''));
async function loadEvent(eventIdOrSlug) {
  const q = isValidObjectId(eventIdOrSlug)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(eventIdOrSlug) }, { slug: String(eventIdOrSlug) }] }
    : { slug: String(eventIdOrSlug) };
  const ev = await Event.findOne(q).lean();
  if (!ev) throw new Error('Event not found');
  return ev;
}

// Charge tarifs/prix : priorité à la table "évènement".
// Si AUCUN tarif d'évènement n'existe, fallback sur saison/lieu (mode legacy).
function shouldFallbackToPublic(channelCtx) {
  if (!channelCtx) return false;
  if (channelCtx.kind === 'partner') {
    return channelCtx.partnerConfig?.allowPublicTariffs === true;
  }
  return false;
}

function isPartnerPresaleAllowed(ev, channelCtx) {
  if (!channelCtx || channelCtx.kind !== 'partner') return false;
  const cfg = channelCtx.partnerConfig || {};
  const quota = Number(cfg?.presale?.events?.[ev?.slug]?.quota || 0);
  return quota > 0;
}

async function getPartnerPresaleRemaining(ev, channelCtx) {
  if (!isPartnerPresaleAllowed(ev, channelCtx)) return null;
  const cfg = channelCtx.partnerConfig || {};
  const quota = Number(cfg?.presale?.events?.[ev?.slug]?.quota || 0);
  if (!(quota > 0)) return null;
  const usedAgg = await Order.aggregate([
    {
      $match: {
        eventId: ev._id,
        'meta.partner.slug': channelCtx.partnerSlug || cfg.slug,
        status: { $nin: ['canceled', 'failed'] }
      }
    },
    { $unwind: '$lines' },
    {
      $group: {
        _id: null,
        qty: { $sum: { $ifNull: ['$lines.qty', { $ifNull: ['$lines.quantity', 1] }] } }
      }
    }
  ]);
  const used = usedAgg?.[0]?.qty || 0;
  return Math.max(0, quota - used);
}

function resolveVenueViewForEvent(ev, channelCtx) {
  if (!channelCtx || channelCtx.kind !== 'partner') {
    return ev?.venueView || null;
  }
  const cfg = channelCtx.partnerConfig || {};
  const slugKey = (ev?.slug || '').trim();
  const nameKey = (ev?.name || '').trim();
  const lowerSlug = slugKey.toLowerCase();
  const lowerName = nameKey.toLowerCase();
  const eventsMap = cfg?.venueViews?.events || {};
  const seasonsMap = cfg?.venueViews?.seasons || {};
  const seasonKey = (ev?.seasonCode || ev?.season || '').trim();
  const lowerSeason = seasonKey.toLowerCase();
  const eventView =
    eventsMap[slugKey] ||
    eventsMap[nameKey] ||
    eventsMap[lowerSlug] ||
    eventsMap[lowerName] ||
    null;
  const seasonView =
    seasonsMap[seasonKey] ||
    seasonsMap[lowerSeason] ||
    null;
  return eventView || seasonView || cfg.venueView || ev?.venueView || null;
}

async function loadTariffsAndPrices(ev, channelCtx) {
  const evTariffs = await Tariff.find({ priceTableKey: ev.priceTableKey, active: true }).lean();
  if (evTariffs.length > 0) {
    const evPrices = await TariffPrice.find({ priceTableKey: ev.priceTableKey }).lean();
    if (shouldFallbackToPublic(channelCtx)) {
      const partnerFiltered = filterTariffsAndPricesByChannel(evTariffs, evPrices, channelCtx, { fallbackToPublic: false });
      const publicFiltered = filterTariffsAndPricesByChannel(evTariffs, evPrices, { kind: 'public' }, { fallbackToPublic: false });
      const tariffsMap = new Map();
      for (const t of publicFiltered.tariffs || []) {
        tariffsMap.set(String(t.code || '').toUpperCase(), t);
      }
      for (const t of partnerFiltered.tariffs || []) {
        tariffsMap.set(String(t.code || '').toUpperCase(), t); // partner overrides
      }
      const priceMap = new Map();
      for (const p of publicFiltered.prices || []) {
        const key = `${String(p.zoneKey || '').toUpperCase()}::${String(p.tariffCode || '').toUpperCase()}`;
        priceMap.set(key, p);
      }
      for (const p of partnerFiltered.prices || []) {
        const key = `${String(p.zoneKey || '').toUpperCase()}::${String(p.tariffCode || '').toUpperCase()}`;
        priceMap.set(key, p); // partner overrides
      }
      return {
        tariffs: Array.from(tariffsMap.values()),
        prices: Array.from(priceMap.values()),
        scope: 'event'
      };
    }
    const filtered = filterTariffsAndPricesByChannel(evTariffs, evPrices, channelCtx, { fallbackToPublic: false });
    return { ...filtered, scope: 'event' };
  }
  const fbTariffs = await Tariff.find({ seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, active: true }).lean();
  const fbPrices = await TariffPrice.find({ seasonCode: ev.seasonCode, venueSlug: ev.venueSlug }).lean();
  if (shouldFallbackToPublic(channelCtx)) {
    const partnerFiltered = filterTariffsAndPricesByChannel(fbTariffs, fbPrices, channelCtx, { fallbackToPublic: false });
    const publicFiltered = filterTariffsAndPricesByChannel(fbTariffs, fbPrices, { kind: 'public' }, { fallbackToPublic: false });
    const tariffsMap = new Map();
    for (const t of publicFiltered.tariffs || []) {
      tariffsMap.set(String(t.code || '').toUpperCase(), t);
    }
    for (const t of partnerFiltered.tariffs || []) {
      tariffsMap.set(String(t.code || '').toUpperCase(), t);
    }
    const priceMap = new Map();
    for (const p of publicFiltered.prices || []) {
      const key = `${String(p.zoneKey || '').toUpperCase()}::${String(p.tariffCode || '').toUpperCase()}`;
      priceMap.set(key, p);
    }
    for (const p of partnerFiltered.prices || []) {
      const key = `${String(p.zoneKey || '').toUpperCase()}::${String(p.tariffCode || '').toUpperCase()}`;
      priceMap.set(key, p);
    }
    return {
      tariffs: Array.from(tariffsMap.values()),
      prices: Array.from(priceMap.values()),
      scope: 'fallback'
    };
  }
  const filtered = filterTariffsAndPricesByChannel(fbTariffs, fbPrices, channelCtx, { fallbackToPublic: false });
  return { ...filtered, scope: 'fallback' };
}

function buildAllowedFromPrices(prices) {
  const map = new Map(); // ZONEKEY(UPPER) -> Set(TARIFF UPPER)
  for (const p of (prices || [])) {
    const z = String(p.zoneKey || '').trim().toUpperCase();
    const t = String(p.tariffCode || '').trim().toUpperCase();
    if (!map.has(z)) map.set(z, new Set());
    map.get(z).add(t);
  }
  return {
    allowedZones: Array.from(map.keys()),
    allowedTariffsByZone: Object.fromEntries(
      Array.from(map.entries()).map(([z, set]) => [z, Array.from(set)])
    )
  };
}

async function computeSeatStates(ev, sessionToken = '') {
  // Base: états des sièges pour la saison/lieu (provisions/holds abonnements, VIP, etc.)
  const base = await Seat.find(
    { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug },
    { seatId: 1, zoneKey: 1, status: 1, _id: 0 }
  ).lean();

  const byId = new Map(base.map(s => [String(s.seatId), { seatId: s.seatId, zoneKey: s.zoneKey, status: String(s.status || 'available').toLowerCase() }]));

  // Surcouche: ordres paid/tobepaid pour CET évènement -> booked
  const paid = await Order.find(
    {
      status: { $in: ['paid', 'tobepaid'] },
      $or: [
        { eventId: ev._id },
        { 'meta.eventId': String(ev._id) }
      ]
    },
    { lines: 1, _id: 0 }
  ).lean();

  for (const ord of (paid || [])) {
    for (const ln of (ord.lines || [])) {
      const placement = resolveLinePlacement(ln);
      if (placement.released) continue;
      const sid = String(placement.seatId || '').trim();
      if (!sid) continue;                 // lignes de zone → pas de seatId
      if (isVirtualZoneSeatId(sid)) continue; // IDs virtuels (zones) → ignorer
      if (!byId.has(sid)) continue;       // ⛔ ne crée PAS de siège fantôme
      const rec = byId.get(sid);
      rec.status = 'booked';
      byId.set(sid, rec);
    }
  }

  // Surcouche: SeatHold actifs (sélections en cours d'autres sessions) -> busy
  const holds = await SeatHold.find(
    { eventId: ev._id, expiresAt: { $gt: new Date() } },
    { seatId: 1, sessionToken: 1, _id: 0 }
  ).lean();

  for (const hold of holds) {
    const sid = String(hold.seatId || '').trim();
    if (!sid) continue;
    if (sessionToken && hold.sessionToken === sessionToken) continue; // propre sélection → reste available
    if (!byId.has(sid)) continue;
    const rec = byId.get(sid);
    if (rec.status === 'available') {
      rec.status = 'busy';
      byId.set(sid, rec);
    }
  }

  return Array.from(byId.values());
}

function buildOrigin(flowKey, uiPath, extraOrigin) {
  return (req) => ({
    flow: flowKey,
    uiPath,
    apiPath: `${req.baseUrl || ''}${req.path}`,
    ...(extraOrigin || {})
  });
}

export function createEventFlowRouter({
  flowKey = 'event',
  uiPath = '/event',
  itemNamePrefix = 'EVENT',
  groupKeyPrefix = 'EVENT',
  mailTemplateKind = 'event',
  originExtras = {},
  channelResolver = () => ({ kind: 'public' }),
  originResolver = null,
  invoiceReservations = null
} = {}) {
  // mergeParams is required so nested routers (e.g., /partner/:partnerSlug/event/:eventId)
  // can access upstream params like partnerSlug in channelResolver.
  const router = Router({ mergeParams: true });
  const originBuilder = buildOrigin(flowKey, uiPath, originExtras);
  const resolveInvoiceOptions = (req, channelCtx) => {
    if (!invoiceReservations) return null;
    if (typeof invoiceReservations === 'function') {
      return invoiceReservations(req, channelCtx);
    }
    return invoiceReservations;
  };

  async function prepareOrderContext(req, ev, channelCtx) {
    const { payer, items, schedule } = req.body || {};
    assert(Array.isArray(items) && items.length > 0, 'Panier vide');

    const sessionToken = String(req.query?.sessionToken || req.body?.sessionToken || '').trim().slice(0, 64);
    const seats = await computeSeatStates(ev, sessionToken);
    const statusIdx = new Map(seats.map(s => [String(s.seatId), s.status]));
    for (const it of items) {
      const sidRaw = String(it.seatId || '').trim();
      const sid = (sidRaw && statusIdx.has(sidRaw)) ? sidRaw : '';
      const z = String(it.zoneKey || '').trim().toUpperCase();
      assert(z, 'zoneKey manquant');
      if (sid && statusIdx.has(sid)) {
        const st = statusIdx.get(sid) || 'available';
        assert(st === 'available', `Siège indisponible: ${sid} (${st})`);
      }
    }

    const { prices, scope } = await loadTariffsAndPrices(ev, channelCtx);
    const pmap = new Map(prices.map(p => {
      const key = `${String(p.zoneKey || '').toUpperCase()}::${String(p.tariffCode || '').toUpperCase()}`;
      const display = Number(p.priceCents) || 0;
      const partner = Number(
        (p.partnerPriceCents != null ? p.partnerPriceCents : p.priceCents)
      ) || display;
      return [key, { display, partner }];
    }));

    const lines = items.map(it => {
      const z = String(it.zoneKey || '').toUpperCase();
      const t = String(it.tariffCode || '').toUpperCase();
      const sidRaw = String(it.seatId || '').trim();
      const realSeat = sidRaw && statusIdx.has(sidRaw);
      const sid = realSeat ? sidRaw : '';
      const key = `${z}::${t}`;
      const priceObj = pmap.get(key);
      if (!priceObj) {
        throw new Error(`Tarif indisponible pour la zone (${z}/${t})${scope === 'fallback' ? ' [fallback]' : ''}`);
      }
      const displayPrice = Number(priceObj.display) || 0;
      const partnerPrice = Number(priceObj.partner) || displayPrice;
      const partnerTotal = displayPrice + partnerPrice;
      return {
        seatId: sid,
        zoneKey: z,
        tariffCode: t,
        priceCents: displayPrice,
        partnerPriceCents: partnerPrice,
        partnerTotalCents: partnerTotal,
        holderFirstName: String(it.firstName || ''),
        holderLastName: String(it.lastName || ''),
        justif: String(it.justif || '').trim(),
        info: String(it.info || '').trim()
      };
    });

    const totalCents = lines.reduce((s, l) => s + (Number(l.priceCents) || 0), 0);
    const partnerTotals = channelCtx?.kind === 'partner'
      ? lines.reduce((acc, l) => {
          const partnerPrice = Number(l.partnerPriceCents ?? l.priceCents) || 0;
          const displayPrice = Number(l.priceCents) || 0;
          const partnerTotal = Number(l.partnerTotalCents ?? displayPrice + partnerPrice) || (displayPrice + partnerPrice);
          acc.partnerContribution += partnerPrice;
          acc.displayTotal += displayPrice;
          acc.partnerTotal += partnerTotal;
          return acc;
        }, { partnerContribution: 0, displayTotal: 0, partnerTotal: 0 })
      : null;
    assert(totalCents > 0, 'Montant total nul (tarifs manquants ?)');

    const normalizedPayer = {
      firstName: String(payer?.firstName || '').trim(),
      lastName: String(payer?.lastName || '').trim(),
      email: String(payer?.email || '').trim()
    };
    let scheduleValue = Number(schedule || 1);
    if (!Number.isFinite(scheduleValue) || scheduleValue <= 0) scheduleValue = 1;
    const holdable = lines.filter(ln => !!ln.seatId && statusIdx.has(ln.seatId));

    return {
      payer: normalizedPayer,
      schedule: scheduleValue,
      lines,
      totalCents,
      statusIdx,
      holdable,
      partnerTotals
    };
  }

  // GET /:eventId/status
  router.get('/:eventId/status', async (req, res) => {
    try {
      const sessionToken = String(req.query.sessionToken || '').trim().slice(0, 64);
      const channelCtx = channelResolver(req) || { kind: flowKey === 'partner' ? 'partner' : 'public' };
      const ev = await loadEvent(req.params.eventId);
      const presaleRemaining = await getPartnerPresaleRemaining(ev, channelCtx);
      const presaleQuota = isPartnerPresaleAllowed(ev, channelCtx)
        ? Number(channelCtx?.partnerConfig?.presale?.events?.[ev?.slug]?.quota || 0)
        : 0;
      const saleStatus = (() => {
        if (ev.isOnSale === true) return 'sale_opened';
        if (isPartnerPresaleAllowed(ev, channelCtx)) {
          if (presaleRemaining !== null && presaleRemaining <= 0) return 'presale_quota_reached';
          return 'presale_opened';
        }
        return 'sale_closed';
      })();
      const resolvedVenueView = resolveVenueViewForEvent(ev, channelCtx);
      const [seatsBase, { tariffs, prices, scope }] = await Promise.all([
        computeSeatStates(ev, sessionToken),
        loadTariffsAndPrices(ev, channelCtx)
      ]);

      // 1) Zones autorisées à partir des prix (UPPERCASE partout)
      const { allowedZones, allowedTariffsByZone } = buildAllowedFromPrices(prices);
      let allowedSet = new Set(
        (allowedZones || [])
          .map(z => String(z || '').trim().toUpperCase())
          .filter(Boolean)
      );

      // 2) Récupère meta zones
      let zonesMeta = {};
      let zonesKind = {}; // { KEY: 'seated'|'standing'|'fanclub' }
      let publics = [];
      try {
        const zoneMatch = (flowKey === 'partner')
          ? { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, isActive: true, key: { $in: Array.from(allowedSet) } }
          : { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, access: 'PUBLIC', isActive: true };

        const zoneDocs = await Zone.find(
          zoneMatch,
          { key: 1, name: 1, type: 1, capacity: 1, quota: 1, _id: 0 }
        ).lean();

        const seenKeys = new Set();
        publics = [];
        for (const z of (Array.isArray(zoneDocs) ? zoneDocs : [])) {
          const K = String(z.key || '').trim().toUpperCase();
          if (!K || seenKeys.has(K)) continue;
          seenKeys.add(K);
          publics.push({ ...z, key: K });
        }

        if (publics.length > 0) {
          const publicSet = new Set(publics.map(z => z.key));
          // Partner: don't shrink allowedSet; otherwise intersect with PUBLIC zones
          if (flowKey !== 'partner') {
            allowedSet = new Set([...allowedSet].filter(z => publicSet.has(String(z).trim().toUpperCase())));
          }
          zonesMeta = publics.reduce((acc, z) => {
            const K = z.key || '';
            acc[K] = z.name || K;
            return acc;
          }, {});
          zonesKind = publics.reduce((acc, z) => {
            const K = z.key || '';
            acc[K] = z.type || 'seated';
            return acc;
          }, {});
        }
      } catch {
        /* ignore filtre zones */
      }

      // 3) Marque les sièges sélectionnables (status available + zone autorisée)
      const seatsOut = (seatsBase || []).map(s => ({
        ...s,
        allowed:
          (String(s.status || '').toLowerCase() === 'available') &&
          allowedSet.has(String(s.zoneKey || '').trim().toUpperCase())
      }));

      let standingZones = [];
      const standingDocs = (publics || []).filter(z => {
        const key = String(z.key || '').trim().toUpperCase();
        return key && allowedSet.has(key) && String(z.type || '').toLowerCase() === 'standing';
      });
      if (standingDocs.length) {
        const zoneCapacity = new Map(standingDocs.map(z => {
          const key = String(z.key || '').trim().toUpperCase();
          const quota = Number(z.quota || 0);
          const capacity = Number(z.capacity || 0);
          const base = quota > 0 ? quota : capacity;
          return [key, base > 0 ? base : 0];
        }));

        const zoneSold = new Map();
        const eventOrders = await Order.find(
          {
            status: { $in: ['paid', 'tobepaid'] },
            $or: [
              { eventId: ev._id },
              { 'meta.eventId': String(ev._id) }
            ]
          },
          { lines: 1, parentOrderId: 1 }
        ).lean();

        let subscriptionOrders = [];
        const hasImportedSeason = eventOrders.some(o => o.parentOrderId);
        if (!hasImportedSeason) {
          subscriptionOrders = await Order.find(
            {
              phase: 'subscription',
              seasonCode: ev.seasonCode,
              venueSlug: ev.venueSlug,
              status: { $in: ['paid', 'tobepaid'] }
            },
            { lines: 1 }
          ).lean();
        }

        for (const ord of eventOrders) {
          for (const line of ord?.lines || []) {
            const placement = resolveLinePlacement(line);
            if (placement.released) continue;
            const key = String(placement.zoneKey || '').trim().toUpperCase();
            if (!zoneCapacity.has(key)) continue;
            const seatId = typeof placement?.seatId === 'string' ? placement.seatId.trim() : '';
            if (seatId) continue;
            const qtyRaw = Number(line?.qty ?? line?.quantity ?? 1);
            const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
            zoneSold.set(key, (zoneSold.get(key) || 0) + qty);
          }
        }

        for (const ord of subscriptionOrders) {
          for (const line of ord?.lines || []) {
            const key = String(line?.zoneKey || '').trim().toUpperCase();
            if (!zoneCapacity.has(key)) continue;
            const seatId = typeof line?.seatId === 'string' ? line.seatId.trim() : '';
            if (seatId) continue;
            const qtyRaw = Number(line?.qty ?? line?.quantity ?? 1);
            const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
            zoneSold.set(key, (zoneSold.get(key) || 0) + qty);
          }
        }

        standingZones = standingDocs.map(doc => {
          const key = String(doc.key || '').toUpperCase();
          const label = doc.name || doc.key || key;
          const capacity = zoneCapacity.get(key) || 0;
          const sold = zoneSold.get(key) || 0;
          const remaining = capacity > 0 ? Math.max(0, capacity - sold) : 0;
          return { key, label, capacity, sold, remaining };
        });
      }

      res.json({
        ok: true,
        seasonCode: ev.seasonCode,
        venueSlug: ev.venueSlug,
        venueView: resolvedVenueView,
        event: {
          id: String(ev._id),
          slug: ev.slug,
          name: ev.name,
          startsAt: ev.startsAt,
          isOnSale: ev.isOnSale,
          venueView: resolvedVenueView,
          saleStatus
        },
        tariffs, prices, scope,
        allowedZones: Array.from(allowedSet),
        allowedTariffsByZone,
        zonesMeta,
        zonesKind,
        seats: seatsOut,
        standingZones,
        presale: isPartnerPresaleAllowed(ev, channelCtx)
          ? { allowed: true, remaining: presaleRemaining ?? null, quota: presaleQuota }
          : { allowed: false },
        saleStatus,
        holdTtlSec: SEAT_HOLD_TTL_MIN * 60,
        channel: channelCtx?.kind === 'partner'
          ? `partner:${channelCtx.partnerSlug || ''}`
          : (channelCtx?.kind || 'public')
      });
    } catch (e) {
      res.status(404).json({ ok: false, error: e.message || 'Not found' });
    }
  });

  // GET /:eventId/seats — seat states only (lightweight polling)
  router.get('/:eventId/seats', async (req, res) => {
    try {
      const sessionToken = String(req.query.sessionToken || '').trim().slice(0, 64);
      const ev = await loadEvent(req.params.eventId);
      const seats = await computeSeatStates(ev, sessionToken);
      res.json({ ok: true, seats, ts: Date.now() });
    } catch (e) {
      res.status(404).json({ ok: false, error: e.message || 'Not found' });
    }
  });

  // POST /:eventId/hold — réserve temporaire de sièges (atomic hold-or-conflict)
  router.post('/:eventId/hold', async (req, res) => {
    try {
      const ev = await loadEvent(req.params.eventId);
      const sessionToken = String(req.body?.sessionToken || '').trim().slice(0, 64);
      if (!sessionToken) return res.status(400).json({ ok: false, error: 'sessionToken required' });

      const seatIds = (Array.isArray(req.body?.seatIds) ? req.body.seatIds : [])
        .map(s => String(s || '').trim()).filter(Boolean).slice(0, 30);
      if (!seatIds.length) return res.json({ ok: true, held: [], conflicts: [], holdTtlSec: SEAT_HOLD_TTL_MIN * 60 });

      const now = new Date();
      const expiresAt = new Date(now.getTime() + SEAT_HOLD_TTL_MIN * 60 * 1000);
      const held = [];
      const conflicts = [];

      const results = await Promise.allSettled(seatIds.map(async (seatId) => {
        // 1) Renouvelle si c'est notre hold ou un hold expiré
        const updated = await SeatHold.findOneAndUpdate(
          {
            eventId: ev._id,
            seatId,
            $or: [
              { sessionToken },
              { expiresAt: { $lte: now } }
            ]
          },
          { $set: { sessionToken, expiresAt, seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, reason: 'selection' } },
          { new: true }
        );
        if (updated) return { seatId, status: 'held' };

        // 2) Vérifie si un hold actif d'une autre session existe
        const activeHold = await SeatHold.findOne(
          { eventId: ev._id, seatId, expiresAt: { $gt: now } },
          { _id: 1 }
        ).lean();
        if (activeHold) return { seatId, status: 'conflict' };

        // 3) Aucun hold → crée (catch 11000 si index unique actif)
        try {
          await SeatHold.create({
            eventId: ev._id, seatId, sessionToken, expiresAt,
            seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, reason: 'selection'
          });
          return { seatId, status: 'held' };
        } catch (err) {
          if (err.code === 11000) return { seatId, status: 'conflict' };
          throw err;
        }
      }));

      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value.status === 'held') held.push(r.value.seatId);
          else conflicts.push(r.value.seatId);
        }
      }

      const ok = conflicts.length === 0 && held.length > 0;
      res.json({ ok, held, conflicts, heldUntil: expiresAt.toISOString(), holdTtlSec: SEAT_HOLD_TTL_MIN * 60 });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // DELETE /:eventId/hold — libère les holds d'une session (seatIds précis ou tous)
  router.delete('/:eventId/hold', async (req, res) => {
    try {
      const ev = await loadEvent(req.params.eventId);
      const sessionToken = String(req.body?.sessionToken || '').trim().slice(0, 64);
      if (!sessionToken) return res.status(400).json({ ok: false, error: 'sessionToken required' });

      const seatIds = (Array.isArray(req.body?.seatIds) ? req.body.seatIds : [])
        .map(s => String(s || '').trim()).filter(Boolean);

      const filter = seatIds.length
        ? { eventId: ev._id, sessionToken, seatId: { $in: seatIds } }
        : { eventId: ev._id, sessionToken };

      await SeatHold.deleteMany(filter);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /:eventId/checkout
  router.post('/:eventId/checkout', async (req, res) => {
    try {
      const channelCtx = channelResolver(req) || { kind: flowKey === 'partner' ? 'partner' : 'public' };
      const ev = await loadEvent(req.params.eventId);
      const presale = isPartnerPresaleAllowed(ev, channelCtx);
      const remaining = await getPartnerPresaleRemaining(ev, channelCtx);
      assert(ev.isOnSale === true || (presale && (remaining ?? 0) > 0), 'Vente fermée pour cet événement.');

      const ctxData = await prepareOrderContext(req, ev, channelCtx);
      if (ev.isOnSale !== true && presale) {
        const qty = ctxData.lines.reduce((sum, ln) => sum + Number(ln.qty ?? ln.quantity ?? 1), 0);
        if ((remaining ?? 0) <= 0 || qty > (remaining ?? 0)) {
          return res.status(400).json({
            ok: false,
            error: 'partner_presale_quota_exceeded',
            remaining: remaining ?? 0,
            message: `Quota prévente atteint (restant: ${remaining ?? 0})`
          });
        }
      }
      const payerInfo = ctxData.payer;
      const scheduleValue = ctxData.schedule;
      const partnerMeta = (channelCtx?.kind === 'partner' && ctxData.partnerTotals)
        ? {
            slug: channelCtx.partnerSlug || null,
            displayTotalCents: ctxData.partnerTotals.displayTotal,
            partnerContributionCents: ctxData.partnerTotals.partnerContribution,
            partnerTotalCents: ctxData.partnerTotals.partnerTotal
          }
        : null;

      // Crée order "pending" + hold
      const now = new Date();
      const until = new Date(now.getTime() + HOLD_MIN * 60 * 1000);
      const uniqueGroupKey = `${groupKeyPrefix}-${ev.slug}-${new mongoose.Types.ObjectId().toString()}`;

      const baseOrigin = originBuilder(req);
      const resolvedOrigin = typeof originResolver === 'function'
        ? originResolver(req, baseOrigin, channelCtx) || baseOrigin
        : baseOrigin;

      const ord = await Order.create({
        eventId: ev._id,
        itemName: `${itemNamePrefix}_${ev.slug}`,
        phase: 'event',
        paymentProvider: PAYMENT_PROVIDER_ID,
        paymentProviderMeta: {},

        createdAt: now,
        status: 'pending',
        groupKey: uniqueGroupKey,
        payer: payerInfo,
        lines: ctxData.lines,
        payerFirstName: payerInfo.firstName,
        payerLastName: payerInfo.lastName,
        payerEmail: payerInfo.email,
        totalCents: ctxData.totalCents,
        installment: scheduleValue,
        paymentSplit: scheduleValue,
        seasonCode: ev.seasonCode,
        venueSlug: ev.venueSlug,
        schedule: scheduleValue,
        meta: {
          eventId: String(ev._id),
          eventSlug: ev.slug,
          eventName: ev.name,
          eventStartsAt: ev.startsAt,
          provider: PAYMENT_PROVIDER_ID,
          ...(partnerMeta ? { partner: partnerMeta } : {})
        },

        origin: resolvedOrigin,
        mailTemplateKind,
        hold: { until }
      });

      // Libère les SeatHolds pre-checkout de cette session (remplacés par le hold Order)
      const checkoutSessionToken = String(req.query.sessionToken || req.body?.sessionToken || '').trim().slice(0, 64);
      if (checkoutSessionToken) {
        SeatHold.deleteMany({ eventId: ev._id, sessionToken: checkoutSessionToken }).catch(() => {});
      }

      // Pose des holds uniquement pour les VRAIS sièges (présents dans statusIdx)
      if (ctxData.holdable.length) {
        await Promise.all(ctxData.holdable.map(ln =>
          Seat.updateOne(
            { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, seatId: ln.seatId, status: { $ne: 'booked' } },
            { $set: { status: 'busy', 'meta.hold': { orderId: String(ord._id), until } } }
          )
        ));
      }

      // Intent paiement
      let intent = null;
      try {
        const urls = buildReturnUrls(ord);
        intent = await createCheckoutIntent({
          order: ord,
          returnUrl: urls.returnUrl,
          backUrl: urls.backUrl,
          errorUrl: urls.errorUrl
        });
        if (intent?.id || intent?.checkoutReference || intent?.raw?.checkout_reference) {
          const checkoutId = String(intent.id || intent.checkoutReference || intent.raw?.checkout_reference || '');
          ord.paymentProvider = PAYMENT_PROVIDER_ID;
          ord.paymentProviderMeta = {
            ...(ord.paymentProviderMeta || {}),
            name: PAYMENT_PROVIDER_ID,
            checkoutIntentId: checkoutId,
            checkoutReference: intent.checkoutReference || intent.raw?.checkout_reference || checkoutId,
            providerRedirectUrl: intent.redirectUrl || intent.url || null,
            providerOrderId:
              intent.providerOrderId ||
              intent.raw?.order?.id ||
              intent.raw?.orderId ||
              intent.raw?.transaction_code ||
              intent.raw?.transaction_id ||
              intent.raw?.id ||
              null
          };
          await ord.save();
        }
      } catch (err) {
        throw new Error(`Payment provider unavailable: ${err.message || err}`);
      }

      const redirectUrl = buildPayStartUrl(ord._id);
      const checkoutId  = String(ord.paymentProviderMeta?.checkoutIntentId || '');
      res.json({
        ok: true,
        orderId:     String(ord._id),
        redirectUrl,                                              // /pay/start (legacy fallback)
        providerUrl: intent.redirectUrl || intent.url || null,   // direct provider URL (SumUp hosted checkout)
        statusUrl:   buildPayStatusUrl(ord._id),                 // polling endpoint
        returnUrl:   buildPayReturnUrl(ord._id, checkoutId),     // final confirmation page
        checkout:    intent
      });
    } catch (e) {
      console.error(`[${flowKey}/checkout] error:`, e?.message || e);
      res.status(400).json({ ok: false, error: e.message || 'Checkout error' });
    }
  });

  router.post('/:eventId/reserve', async (req, res) => {
    const channelCtx = channelResolver(req) || { kind: flowKey === 'partner' ? 'partner' : 'public' };
    const invoiceOpts = resolveInvoiceOptions(req, channelCtx);
    if (!invoiceOpts?.enabled) {
      return res.status(404).json({ ok: false, error: 'reservation_unavailable' });
    }

      try {
        const ev = await loadEvent(req.params.eventId);
        const presale = isPartnerPresaleAllowed(ev, channelCtx);
        const remaining = await getPartnerPresaleRemaining(ev, channelCtx);
        assert(ev.isOnSale === true || (presale && (remaining ?? 0) > 0), 'Vente fermée pour cet événement.');

        const ctxData = await prepareOrderContext(req, ev, channelCtx);
        if (ev.isOnSale !== true && presale) {
          const qty = ctxData.lines.reduce((sum, ln) => sum + Number(ln.qty ?? ln.quantity ?? 1), 0);
          if ((remaining ?? 0) <= 0 || qty > (remaining ?? 0)) {
            return res.status(400).json({
              ok: false,
              error: 'partner_presale_quota_exceeded',
              remaining: remaining ?? 0,
              message: `Quota prévente atteint (restant: ${remaining ?? 0})`
            });
          }
        }
        const now = new Date();
        const until = new Date(now.getTime() + HOLD_MIN * 60 * 1000);
        const uniqueGroupKey = `${groupKeyPrefix}-${ev.slug}-INV-${new mongoose.Types.ObjectId().toString()}`;

        const baseOrigin = originBuilder(req);
        const resolvedOrigin = typeof originResolver === 'function'
          ? originResolver(req, baseOrigin, channelCtx) || baseOrigin
          : baseOrigin;
        const partnerMeta = (channelCtx?.kind === 'partner' && ctxData.partnerTotals)
          ? {
              slug: channelCtx.partnerSlug || null,
              displayTotalCents: ctxData.partnerTotals.displayTotal,
              partnerContributionCents: ctxData.partnerTotals.partnerContribution,
              partnerTotalCents: ctxData.partnerTotals.partnerTotal
            }
          : null;

        const ord = await Order.create({
          eventId: ev._id,
          itemName: `${itemNamePrefix}_${ev.slug}`,
          phase: 'event',
          paymentProvider: invoiceOpts.paymentProvider || 'invoice',
          paymentProviderMeta: {
            mode: 'invoice',
            ...(invoiceOpts.paymentProviderMeta || {}),
            channel: channelCtx?.kind || null,
            partnerSlug: channelCtx?.partnerSlug || null
          },
          createdAt: now,
          status: invoiceOpts.status || 'pending_invoice',
          groupKey: uniqueGroupKey,
          payer: ctxData.payer,
          lines: ctxData.lines,
          payerFirstName: ctxData.payer.firstName,
          payerLastName: ctxData.payer.lastName,
          payerEmail: ctxData.payer.email,
          totalCents: ctxData.totalCents,
          installment: ctxData.schedule,
          paymentSplit: ctxData.schedule,
          seasonCode: ev.seasonCode,
          venueSlug: ev.venueSlug,
          schedule: ctxData.schedule,
          meta: {
            eventId: String(ev._id),
            eventSlug: ev.slug,
            eventName: ev.name,
            eventStartsAt: ev.startsAt,
            provider: invoiceOpts.paymentProvider || 'invoice',
            invoiceMode: invoiceOpts.invoiceMode || 'deferred',
            partnerSlug: channelCtx?.partnerSlug || null,
            ...(partnerMeta ? { partner: partnerMeta } : {})
          },
          origin: resolvedOrigin,
          mailTemplateKind: invoiceOpts.mailTemplateKind || mailTemplateKind,
          hold: { until }
        });

        if (ctxData.holdable.length) {
          await Promise.all(ctxData.holdable.map(ln =>
            Seat.updateOne(
              { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, seatId: ln.seatId, status: { $ne: 'booked' } },
              { $set: { status: 'busy', 'meta.hold': { orderId: String(ord._id), until } } }
            )
          ));
        }

        if (invoiceOpts.autoFinalize) {
          const finalizeResult = await finalizePaidIfNoConflict(ord);
          if (!finalizeResult.ok) {
            return res.status(409).json({ ok: false, error: 'seat_conflict', details: finalizeResult.conflicts });
          }
          if (invoiceOpts.sendTickets !== false) {
            try {
              await sendOrderAttestationIfNeeded(ord, { force: true, source: 'partner-reserve' });
            } catch (err) {
              console.warn('[partner/reserve] attestation send failed:', err.message);
            }
          }
        }

        res.json({ ok: true, orderId: String(ord._id), status: ord.status });
      } catch (e) {
        console.error(`[${flowKey}/reserve] error:`, e?.message || e);
        res.status(400).json({ ok: false, error: e.message || 'Reservation error' });
      }
  });

  return router;
}

export default createEventFlowRouter;
