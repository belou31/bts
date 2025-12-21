// src/routes/subscription.js
import express from 'express';
import mongoose from 'mongoose'; // si pas déjà présent

import { Season }      from '../models/Season.js';
import { Seat }        from '../models/Seat.js';
import { Zone }        from '../models/Zone.js';
import { Tariff }      from '../models/Tariff.js';
import { TariffPrice } from '../models/TariffPrice.js';
import { Order }       from '../models/Order.js';

import { createCheckoutIntent, buildReturnUrls, currentPaymentProviderId } from '../services/payments/index.js';
import { makeTokenHash }        from '../utils/ha-token.js';
import { findSingleGaps }       from '../utils/no-single-gap.js';
import { filterTariffsAndPricesByChannel } from '../utils/tariff-filter.js';

const router = express.Router({ mergeParams: true });

/* ====== ENV / Const ====== */
const PAYMENT_PROVIDER_ID = currentPaymentProviderId();

const HOLD_MIN = Number(process.env.CHECKOUT_HOLD_MIN || 10); // durée du hold en minutes
const HOLD_MS  = HOLD_MIN * 60 * 1000;
const isVirtualZoneSeatId = sid => /^.+-Z\d{3,}$/i.test(String(sid||''));

// zones “grand public” qu’on expose au sélecteur (Fan club + debout)
const SUB_ZONE_KEYS = ['TBH7', 'TBH7-VIRAGE', 'DEBOUT'];

/* ====== Helpers ====== */
const norm  = s => String(s || '').trim();
const upper = s => norm(s).toUpperCase();

async function getActiveSeasonAndVenue() {
  const s = await Season.findOne({ isActive: true }).lean();
  if (!s) { const e = new Error('No active season/venue'); e.status = 503; throw e; }
  const seasonCode = s.code || s.seasonCode;
  const venueSlug  = s.venueSlug || s.venue;
  if (!seasonCode || !venueSlug) { const e = new Error('No active season/venue'); e.status = 503; throw e; }
  return { seasonCode, venueSlug, season: s };
}

async function resolveSeasonAndVenue(inputSeasonCode = '') {
  const requested = norm(inputSeasonCode);
  if (requested && requested.toLowerCase() !== 'current') {
    const seasonDoc = await Season.findOne({
      $or: [{ code: requested }, { seasonCode: requested }]
    }).lean();
    if (!seasonDoc) {
      const err = new Error(`Season not found: ${requested}`);
      err.status = 404;
      throw err;
    }
    const seasonCode = seasonDoc.code || seasonDoc.seasonCode || requested;
    const venueSlug = seasonDoc.venueSlug || seasonDoc.venue;
    if (!venueSlug) {
      const err = new Error('Season missing venue');
      err.status = 500;
      throw err;
    }
    return { seasonCode, venueSlug, season: seasonDoc };
  }
  return await getActiveSeasonAndVenue();
}

function buildPricesIndex(list) {
  // Map "ZONE|TARIFF" -> priceCents (avec fallback *|TARIFF)
  const idx = new Map();
  for (const p of (list || [])) {
    const z = upper(p.zoneKey || p.zone || '*');
    const t = upper(p.tariffCode || p.tariff || '');
    if (!t) continue;
    idx.set(`${z}|${t}`, Number(p.priceCents || 0));
    if (z !== '*' && !idx.has(`*|${t}`)) {
      idx.set(`*|${t}`, Number(p.priceCents || 0));
    }
  }
  return idx;
}
const getPriceCents = (idx, zoneKey, tariffCode) =>
  idx.get(`${upper(zoneKey)}|${upper(tariffCode)}`) ?? idx.get(`*|${upper(tariffCode)}`) ?? 0;

function zoneKeyFromSeatId(seatId) {
  const s = String(seatId || '');
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : s;
}

async function computeZoneUsageAllOrders({ seasonCode, venueSlug, zoneKeys, statusIn = ['paid'] }) {
  // Conso = nombre de lignes de commandes groupées par zone.
  // Par défaut, on retient UNIQUEMENT les commandes "paid" pour le quota subscription.
  const baseMatch = {
    seasonCode,
    venueSlug,
    'lines.zoneKey': { $in: zoneKeys }
  };
  const statusMatch = (Array.isArray(statusIn) && statusIn.length)
    ? { status: { $in: statusIn } }                 // ex: ['paid']
    : { status: { $nin: ['canceled', 'failed'] } }; // fallback historique

  const rows = await Order.aggregate([
    { $match: { ...baseMatch, ...statusMatch } },
    { $unwind: '$lines' },
    { $match: { 'lines.zoneKey': { $in: zoneKeys } } },
    { $group: { _id: '$lines.zoneKey', count: { $sum: 1 } } }
  ]);
  const usage = new Map(rows.map(r => [String(r._id || ''), Number(r.count || 0)]));
  return usage;
}


/* ====== GET /api/season/:seasonCode/status ======
 * Répond: { seasonCode, venueSlug, tariffs[], prices[], seats[], zones[] }
 * zones[]: [{ key,name,quota,capacity,remaining,svgSelector }]
 */
router.get('/status', async (req, res, next) => {
  try {
    const seasonParam = req.params?.seasonCode || req.query?.season || req.query?.seasonCode || '';
    const { seasonCode, venueSlug, season } = await resolveSeasonAndVenue(seasonParam);
    // --- Sièges de la salle (pour le clic direct sur siège côté front)
    const seats = await Seat.find(
      { seasonCode, venueSlug },
      { _id:0, seatId:1, status:1, zoneKey:1 }
    ).lean();

    // --- Zones (Fan club + Debout) depuis le modèle Zone
    const zones = await Zone.find({
      seasonCode, venueSlug,
      key: { $in: SUB_ZONE_KEYS },
      isActive: true
    }).lean();

    // --- Tarifs & Prix applicables (TOUS les prix / tarifs actifs pour la salle)
    const allPrices = await TariffPrice.find({
      seasonCode, venueSlug, isActive: true
    }).lean();
    const allTariffs = await Tariff.find({
      seasonCode, venueSlug, isActive: true
    }).lean();
    const { tariffs, prices } = filterTariffsAndPricesByChannel(
      allTariffs,
      allPrices,
      { kind: 'subscription' }
    );

    // --- Calcul “remaining” zone = plafond - USAGE(only paid)
    const usage = await computeZoneUsageAllOrders({
      seasonCode, venueSlug, zoneKeys: SUB_ZONE_KEYS, statusIn: ['paid']
    });
    const zonesOut = (zones || []).map(z => {
      const quota     = Number(z.quota || 0);
      const capacity  = Number(z.capacity || 0);
      const plafond   = quota > 0 ? quota : capacity;
      const used      = usage.get(z.key) || 0;
      const remaining = plafond > 0 ? Math.max(0, plafond - used) : Math.max(0, capacity - used);
      return {
        key: z.key,
        name: z.name || z.key,
        type: z.type || 'public',
        quota,
        capacity,
        remaining,
        svgSelector: z.svgSelector || null
      };
    });

    res.json({ seasonCode, seasonName: season?.name || null, venueSlug, tariffs, prices, seats, zones: zonesOut });
  } catch (e) { next(e); }
});

/* ====== POST /api/season/:seasonCode/checkout ======
 * Body: {
 *   payer:{firstName,lastName,email},
 *   schedule:1|2|3,
 *   items:[{ seatId, zoneKey, firstName,lastName, tariffCode, justif?, info? }]
 * }
 * Accepte des lignes “siège” (seatId existant en BD) ET “zone” (seatId virtuel)
 */
router.post('/checkout', async (req, res) => {
  try {
    const seasonParam = req.params?.seasonCode || req.body?.seasonCode || req.query?.season || '';
    const { seasonCode, venueSlug, season } = await resolveSeasonAndVenue(seasonParam);
    const payer    = req.body?.payer || {};
    const schedule = Number(req.body?.schedule || 1);
    // Accepte "items" (nouveau) ET "lines" (héritage generic-view)
    const items    = Array.isArray(req.body?.items)
      ? req.body.items
      : (Array.isArray(req.body?.lines) ? req.body.lines : []);


    if (!items.length) return res.status(400).json({ error: 'no_lines' });
    if (![1,2,3].includes(schedule)) return res.status(400).json({ error: 'invalid_schedule' });

    // Prix / Tarifs
    const prices = await TariffPrice.find({ seasonCode, venueSlug, isActive: true }).lean();
    const pricesIdx = buildPricesIndex(prices);

    // Pré-charge sièges demandés (pour distinguer siège réel vs “zone virtuelle”)
    const askedSeatIds = items.map(it => norm(it.seatId)).filter(Boolean);
    const dbSeats = askedSeatIds.length
      ? await Seat.find({ seasonCode, venueSlug, seatId: { $in: askedSeatIds } }).lean()
      : [];
    const seatMap = new Map(dbSeats.map(s => [s.seatId, s]));

    // Prépare contrôle quotas pour zones SUB_ZONE_KEYS
    const zones = await Zone.find({
      seasonCode, venueSlug, key: { $in: SUB_ZONE_KEYS }, isActive: true
    }).lean();
    const zoneMap = new Map(zones.map(z => [z.key, z]));
    const requestedPerZone = new Map(); // zoneKey -> count (lignes “zone” + lignes “siège” attribuées à cette zone si on veut les compter)

    const lines = [];

    for (const it of items) {
      const seatId    = norm(it.seatId);
      const explicitZ = norm(it.zoneKey);
      const zoneKey   = explicitZ || (seatId ? zoneKeyFromSeatId(seatId) : '');

      const tariffCode = upper(it.tariffCode);
      const priceCents = getPriceCents(pricesIdx, zoneKey, tariffCode);

      if (seatMap.has(seatId)) {
        // ----- LIGNE “SIÈGE”
        const s = seatMap.get(seatId);
        if (s.status !== 'available') {
          return res.status(409).json({ error: 'seat_unavailable', seatId, status: s.status });
        }
        lines.push({
          seatId,
          zoneKey: s.zoneKey || zoneKey || '',
          holderFirstName: norm(it.firstName),
          holderLastName:  norm(it.lastName),
          tariffCode,
          priceCents,
          justif: norm(it.justif),
          info:   norm(it.info)
        });
      } else {
        // ----- LIGNE “ZONE” (ID virtuel)
        if (!zoneKey || !zoneMap.has(zoneKey)) {
          return res.status(400).json({ error: 'invalid_zone', zoneKey });
        }
        lines.push({
          seatId,
          zoneKey,
          holderFirstName: norm(it.firstName),
          holderLastName:  norm(it.lastName),
          tariffCode,
          priceCents,
          justif: norm(it.justif),
          info:   norm(it.info)
        });
        requestedPerZone.set(zoneKey, (requestedPerZone.get(zoneKey) || 0) + 1);
      }
    }


    // 🚫 RÈGLE ANTI-TROU (serveur) — contrôle avant création de l'order
    //    Ici on ne contrôle que les lignes “SIÈGE” réels (les lignes “ZONE” n’impactent pas une rangée).
    /*{
      const seatIdsAsked = lines
        .map(l => l.seatId)
        .filter(sid => !!sid && askedSeatIds.includes(sid)); // réels uniquement
      if (seatIdsAsked.length) {
        const { seasonCode, venueSlug } = await getActiveSeasonAndVenue();
        const gaps = await findSingleGaps({ seasonCode, venueSlug, selectedSeatIds: seatIdsAsked });
        if (gaps.length) {
          const g = gaps[0];
          return res.status(409).json({
            error: 'no_single_gap',
            message: `Votre sélection créerait un siège isolé en rangée ${g.row} (zone ${g.zoneKey}).`,
            problems: gaps
          });
        }
      }
    }*/



    // ----- CONTRÔLE QUOTAS SUR LES ZONES -----
    if (requestedPerZone.size) {
      // Garde-fou anti-oversell : ne compter que le "paid" pour autoriser la vente
      const usage = await computeZoneUsageAllOrders({
        seasonCode, venueSlug, zoneKeys: SUB_ZONE_KEYS, statusIn: ['paid']
      });

    for (const [zoneKey, count] of requestedPerZone) {
        const z        = zoneMap.get(zoneKey);
        const used     = usage.get(zoneKey) || 0;
        const quota    = Number(z.quota || 0);
        const capacity = Number(z.capacity || 0);
        const plafond  = quota > 0 ? quota : capacity;
        if (plafond > 0 && (used + count) > plafond) {
          return res.status(409).json({
            error: 'quota_exceeded',
            zoneKey,
            remaining: Math.max(0, plafond - used)
          });
        }
      }
    }

    const totalCents = lines.reduce((acc, l) => acc + Number(l.priceCents || 0), 0);

    // Créer l’order (pending)
    const seasonPath = `/season/${encodeURIComponent(seasonCode)}`;

    const order = await Order.create({
      itemName:`SUBSCRIPTION_${seasonCode}`,
      seasonCode, venueSlug,
      phase: 'subscription',
      groupKey: `SUBSCRIPTION-${seasonCode}`,
      payerFirstName: norm(payer.firstName || ''),
      payerLastName:  norm(payer.lastName  || ''),
      payerEmail:     norm(payer.email     || ''),
      paymentSplit:   schedule,
      lines, totalCents, status: 'pending',
      paymentProvider: PAYMENT_PROVIDER_ID,
      paymentProviderMeta: {},
      origin: { flow: 'subscription', uiPath: seasonPath, apiPath: `${req.baseUrl||''}${req.path}` },
      mailTemplateKind: 'subscription',
      meta: {
        seasonCode,
        seasonName: season?.name || null,
        source: 'season-subscription'
      }
    });

    // HOLD des sièges réels (status available -> busy + meta.hold)
    const holdUntil = new Date(Date.now() + HOLD_MS);
    const realSeatIds = lines
      .map(l => String(l.seatId || '').trim())
      .filter(sid => sid && !isVirtualZoneSeatId(sid));

      if (realSeatIds.length) {
      // Pose les holds uniquement sur les sièges encore disponibles
      const upd = await Seat.updateMany(
        { seasonCode, venueSlug, seatId: { $in: realSeatIds }, status: 'available' },
       {
          $set: {
            status: 'busy',
            'meta.hold': { by: 'checkout', orderId: String(order._id), until: holdUntil }
          }
        },
        { runValidators: false }
      );
      const modified = Number(upd.modifiedCount ?? upd.nModified ?? 0);
      if (modified !== realSeatIds.length) {
        // Rollback strict : ne libère que ce qu'on vient de tenir pour CETTE commande
        await Seat.updateMany(
          {
            seasonCode, venueSlug,
            seatId: { $in: realSeatIds },
            status: 'busy',
            $or: [
              { 'meta.hold.orderId': String(order._id) },
              { 'meta.hold.orderId': order._id } // compat si des holds anciens sont typés ObjectId
            ]
          },
          { $set: { status: 'available' }, $unset: { 'meta.hold': 1 } },
          { runValidators: false }
        );
        order.status = 'failed';
        order.paymentProviderMeta = {
          ...(order.paymentProviderMeta || {}),
          reason: 'pre_hold_mismatch',
          expected: realSeatIds.length,
          modified
        };
        await order.save();
        return res.status(409).json({ ok:false, error:'seat_unavailable', message:'Un des sièges vient d’être pris.' });
      }
    }
      
    const urls = buildReturnUrls(order);
    const intent = await createCheckoutIntent({
      order,
      returnUrl: urls.returnUrl,
      backUrl: urls.backUrl,
      errorUrl: urls.errorUrl
    });
    const { redirectUrl, raw, error } = intent;

    if (error || !redirectUrl) {
      console.error('[subscription] createCheckoutIntent failed:', error);
      return res.status(502).json({ error: 'payment_unavailable' });
    }
    const checkoutId = String(intent?.id || intent?.checkoutReference || raw?.id || raw?.checkout_reference || '');
    if (checkoutId) {
      const checkoutReference = raw?.checkout_reference || intent?.checkoutReference || checkoutId;
      const tokenHash = makeTokenHash({ orderId: order._id, checkoutIntentId: checkoutId });
      order.paymentProviderMeta = {
        ...(order.paymentProviderMeta || {}),
        name: PAYMENT_PROVIDER_ID,
        checkoutIntentId: checkoutId,
        checkoutReference,
        providerOrderId:
          intent.providerOrderId ||
          raw?.order?.id ||
          raw?.orderId ||
          raw?.transaction_code ||
          raw?.transaction_id ||
          raw?.id ||
          null,
        tokenHash
      };

      await order.save();
    }

    return res.json({ ok: true, orderId: order._id, totalCents, redirectUrl });
  } catch (e) {
    const code = e.status || 500;
    console.error('[POST /api/season/checkout] error:', e);
    return res.status(code).json({ error: e.message || 'internal_error' });
  }
});

export default router;
