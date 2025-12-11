// src/routes/event-flow.factory.js
import { Router } from 'express';
import assert from 'node:assert/strict';
import mongoose, { isValidObjectId } from 'mongoose';

import { Event } from '../models/Event.js';
import { Seat } from '../models/Seat.js';
import { Order } from '../models/Order.js';
import { Tariff } from '../models/Tariff.js';
import { TariffPrice } from '../models/TariffPrice.js';
import { Zone } from '../models/Zone.js';
import { createCheckoutIntent, buildReturnUrls, currentPaymentProviderId } from '../services/payments/index.js';
import { resolveLinePlacement } from '../utils/event-attendance.js';
import { finalizePaidIfNoConflict, sendOrderAttestationIfNeeded } from '../services/order-finalization.js';
import { matchesChannel } from '../utils/channel-scopes.js';
import { filterTariffsAndPricesByChannel } from '../utils/tariff-filter.js';

const PAYMENT_PROVIDER_ID = currentPaymentProviderId();
const HOLD_MIN = Number(process.env.CHECKOUT_HOLD_MIN || '5');

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
async function loadTariffsAndPrices(ev, channelCtx) {
  const evTariffs = await Tariff.find({ priceTableKey: ev.priceTableKey, active: true }).lean();
  if (evTariffs.length > 0) {
    const evPrices = await TariffPrice.find({ priceTableKey: ev.priceTableKey }).lean();
    const filtered = filterTariffsAndPricesByChannel(evTariffs, evPrices, channelCtx, { fallbackToPublic: channelCtx?.kind === 'partner' });
    return { ...filtered, scope: 'event' };
  }
  const fbTariffs = await Tariff.find({ seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, active: true }).lean();
  const fbPrices = await TariffPrice.find({ seasonCode: ev.seasonCode, venueSlug: ev.venueSlug }).lean();
  const filtered = filterTariffsAndPricesByChannel(fbTariffs, fbPrices, channelCtx, { fallbackToPublic: channelCtx?.kind === 'partner' });
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

async function computeSeatStates(ev) {
  // Base: états des sièges pour la saison/lieu (provisions/holds abonnements, VIP, etc.)
  const base = await Seat.find(
    { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug },
    { seatId: 1, zoneKey: 1, status: 1, _id: 0 }
  ).lean();

  const byId = new Map(base.map(s => [String(s.seatId), { seatId: s.seatId, zoneKey: s.zoneKey, status: String(s.status || 'available').toLowerCase() }]));

  // Surcouche: ordres paid pour CET évènement -> booked
  const paid = await Order.find(
    {
      status: 'paid',
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
  const router = Router();
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

    const seats = await computeSeatStates(ev);
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
    const pmap = new Map(prices.map(p => [
      `${String(p.zoneKey || '').toUpperCase()}::${String(p.tariffCode || '').toUpperCase()}`,
      Number(p.priceCents) || 0
    ]));

    const lines = items.map(it => {
      const z = String(it.zoneKey || '').toUpperCase();
      const t = String(it.tariffCode || '').toUpperCase();
      const sidRaw = String(it.seatId || '').trim();
      const realSeat = sidRaw && statusIdx.has(sidRaw);
      const sid = realSeat ? sidRaw : '';
      const key = `${z}::${t}`;
      if (!pmap.has(key)) {
        throw new Error(`Tarif indisponible pour la zone (${z}/${t})${scope === 'fallback' ? ' [fallback]' : ''}`);
      }
      return {
        seatId: sid,
        zoneKey: z,
        tariffCode: t,
        priceCents: pmap.get(key),
        holderFirstName: String(it.firstName || ''),
        holderLastName: String(it.lastName || '')
      };
    });

    const totalCents = lines.reduce((s, l) => s + (Number(l.priceCents) || 0), 0);
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
      holdable
    };
  }

  // GET /:eventId/status
  router.get('/:eventId/status', async (req, res) => {
    try {
      const channelCtx = channelResolver(req) || { kind: flowKey === 'partner' ? 'partner' : 'public' };
      const ev = await loadEvent(req.params.eventId);
      const [seatsBase, { tariffs, prices, scope }] = await Promise.all([
        computeSeatStates(ev),
        loadTariffsAndPrices(ev, channelCtx)
      ]);

      // 1) Zones autorisées à partir des prix (UPPERCASE partout)
      const { allowedZones, allowedTariffsByZone } = buildAllowedFromPrices(prices);
      let allowedSet = new Set(
        (allowedZones || [])
          .map(z => String(z || '').trim().toUpperCase())
          .filter(Boolean)
      );

      // 2) Récupère zones PUBLIC actives + construit zonesMeta { KEY: name }
      let zonesMeta = {};
      let zonesKind = {}; // { KEY: 'seated'|'standing'|'fanclub' }
      let publics = [];
      try {
        const zoneDocs = await Zone.find(
          { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, access: 'PUBLIC', isActive: true },
          { key: 1, name: 1, type: 1, capacity: 1, quota: 1, _id: 0 }
        ).lean();
        // Dedup + normalise la clé pour éviter d'afficher deux fois une zone si des doublons/espaces existent en base
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
          allowedSet = new Set([...allowedSet].filter(z => publicSet.has(String(z).trim().toUpperCase())));
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
            status: { $nin: ['canceled', 'failed'] },
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
              status: { $nin: ['canceled', 'failed'] }
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
        event: { id: String(ev._id), slug: ev.slug, name: ev.name, startsAt: ev.startsAt, isOnSale: ev.isOnSale },
        tariffs, prices, scope,
        allowedZones: Array.from(allowedSet),
        allowedTariffsByZone,
        zonesMeta,
        zonesKind,
        seats: seatsOut,
        standingZones,
        channel: channelCtx?.kind || 'public'
      });
    } catch (e) {
      res.status(404).json({ ok: false, error: e.message || 'Not found' });
    }
  });

  // POST /:eventId/checkout
  router.post('/:eventId/checkout', async (req, res) => {
    try {
      const channelCtx = channelResolver(req) || { kind: flowKey === 'partner' ? 'partner' : 'public' };
      const ev = await loadEvent(req.params.eventId);
      assert(ev.isOnSale === true, 'Vente fermée pour cet événement.');

      const ctxData = await prepareOrderContext(req, ev, channelCtx);
      const payerInfo = ctxData.payer;
      const scheduleValue = ctxData.schedule;

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
          provider: PAYMENT_PROVIDER_ID
        },

        origin: resolvedOrigin,
        mailTemplateKind,
        hold: { until }
      });

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

      const redirectUrl = intent?.redirectUrl || intent?.url || null;
      res.json({ ok: true, orderId: String(ord._id), redirectUrl, checkout: intent });
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
        assert(ev.isOnSale === true, 'Vente fermée pour cet événement.');

        const ctxData = await prepareOrderContext(req, ev, channelCtx);
        const now = new Date();
        const until = new Date(now.getTime() + HOLD_MIN * 60 * 1000);
        const uniqueGroupKey = `${groupKeyPrefix}-${ev.slug}-INV-${new mongoose.Types.ObjectId().toString()}`;

        const baseOrigin = originBuilder(req);
        const resolvedOrigin = typeof originResolver === 'function'
          ? originResolver(req, baseOrigin, channelCtx) || baseOrigin
          : baseOrigin;

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
            partnerSlug: channelCtx?.partnerSlug || null
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
