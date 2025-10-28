// src/routes/tbh7.js
import express from 'express';

import { Season }      from '../models/Season.js';
import { Zone }        from '../models/Zone.js';
import { Tariff }      from '../models/Tariff.js';
import { TariffPrice } from '../models/TariffPrice.js';
import { Order }       from '../models/Order.js';

import { createCheckoutIntent, buildReturnUrls, currentPaymentProviderId } from '../services/payments/index.js';
import { makeTokenHash }        from '../utils/ha-token.js';

const router = express.Router();

/* ====== ENV / Const ====== */
const PAYMENT_PROVIDER_ID = currentPaymentProviderId();

// zones TBH7 ciblées (clés exactes de Zone.key)
const TBH7_ZONE_KEYS = ['TBH7', 'TBH7-VIRAGE'];

/* ====== Helpers ====== */
const norm = s => String(s || '').trim();
const upper = s => norm(s).toUpperCase();

async function getActiveSeasonAndVenue() {
  const s = await Season.findOne({ isActive: true }).lean();
  if (!s) {
    const e = new Error('No active season/venue'); e.status = 503; throw e;
  }
  const seasonCode = s.code || s.seasonCode;
  const venueSlug  = s.venueSlug || s.venue;
  if (!seasonCode || !venueSlug) {
    const e = new Error('No active season/venue'); e.status = 503; throw e;
  }
  return { seasonCode, venueSlug };
}

function buildPricesIndex(list) {
  // Map "ZONE|TARIFF" -> priceCents
  const idx = new Map();
  for (const p of list || []) {
    const z = upper(p.zoneKey || p.zone || '*');
    const t = upper(p.tariffCode || p.tariff || '');
    if (!t) continue;
    idx.set(`${z}|${t}`, Number(p.priceCents || 0));
  }
  return idx;
}
const getPriceCents = (idx, zoneKey, tariffCode) => idx.get(`${upper(zoneKey)}|${upper(tariffCode)}`) ?? idx.get(`*|${upper(tariffCode)}`) ?? 0;

async function computeZoneUsage({ seasonCode, venueSlug }) {
  // Regroupe les lignes de commandes TBH7 (non annulées/échouées) par zone
  const rows = await Order.aggregate([
    { $match: {
      seasonCode, venueSlug,
      'origin.flow': 'tbh7',
      status: { $nin: ['canceled', 'failed'] }
    }},
    { $unwind: '$lines' },
    { $group: { _id: '$lines.zoneKey', count: { $sum: 1 } } }
  ]);
  const usage = new Map();
  for (const r of rows) usage.set(String(r._id || ''), Number(r.count || 0));
  return usage;
}

/* ====== GET /api/tbh7/status ======
 * Renvoie: {
 *   season, seasonCode, venue, venueSlug,
 *   tariffs, prices,
 *   seats: [], tokenSeats: [],
 *   zones: [{key,name,quota,capacity,remaining,svgSelector}],
 *   payer: {}
 * }
 */
router.get('/status', async (req, res) => {
  try {
    const { seasonCode, venueSlug } = await getActiveSeasonAndVenue();

    // Zones TBH7 actives
    const zones = await Zone.find({
      seasonCode, venueSlug,
      key: { $in: TBH7_ZONE_KEYS },
      isActive: true
    }).lean();

    // Prix / Tarifs : on ne renvoie que ce qui est applicable aux zones TBH7
    const prices = await TariffPrice.find({
      seasonCode, venueSlug,
      isActive: true,
      $or: [
        { zoneKey: { $in: TBH7_ZONE_KEYS } },
        { zoneKey: '*' } // générique
      ]
    }).lean();

    const tariffCodes = Array.from(new Set((prices || []).map(p => upper(p.tariffCode))));
    const tariffs = await Tariff.find({
      seasonCode, venueSlug,
      isActive: true,
      code: { $in: tariffCodes }
    }).lean();

    // Conso quota par zone (commandes déjà passées TBH7)
    const usage = await computeZoneUsage({ seasonCode, venueSlug });

    const zonesOut = (zones || []).map(z => {
      const quota     = Number(z.quota || 0);
      const capacity  = Number(z.capacity || 0);
      const plafond   = quota > 0 ? quota : capacity; // on priorise quota si défini
      const used      = usage.get(z.key) || 0;
      const remaining = plafond > 0 ? Math.max(0, plafond - used) : Math.max(0, capacity - used);
      return {
        key: z.key,
        name: z.name || z.key,
        type: z.type || 'fanclub',
        quota,
        capacity,
        remaining,
        svgSelector: z.svgSelector || null
      };
    });

    // Pas de sièges imposés pour TBH7 (sélection par zone côté front)
    return res.json({
      season: seasonCode, seasonCode,
      venue : venueSlug,  venueSlug,
      tariffs, prices,
      seats: [],
      tokenSeats: [],
      zones: zonesOut,
      payer: {}
    });
  } catch (e) {
    const code = e.status || 500;
    console.error('[GET /api/tbh7/status] error:', e);
    return res.status(code).json({ error: e.message || 'internal_error' });
  }
});

/* ====== POST /api/tbh7/checkout ======
 * Body: {
 *   items:[{ zoneKey, seatId?, firstName, lastName, tariffCode, justif?, info? }, ...],
 *   payer:{ firstName, lastName, email },
 *   schedule: 1|2|3
 * }
 * Réponse: { ok:true, orderId, totalCents, redirectUrl }
 */
router.post('/checkout', async (req, res) => {
  try {
    const { seasonCode, venueSlug } = await getActiveSeasonAndVenue();

    const items    = Array.isArray(req.body.items) ? req.body.items : [];
    const payer    = req.body.payer || {};
    const schedule = Number(req.body.schedule || 1);

    if (!items.length)                 return res.status(400).json({ error: 'empty_items' });
    if (!payer?.email)                 return res.status(400).json({ error: 'payer_email_required' });
    if (![1,2,3].includes(schedule))   return res.status(400).json({ error: 'invalid_schedule' });

    // Zones TBH7 actives + plafonds pour contrôle quota
    const zones = await Zone.find({
      seasonCode, venueSlug,
      key: { $in: TBH7_ZONE_KEYS },
      isActive: true
    }).lean();
    const zoneMap = new Map((zones || []).map(z => [z.key, z]));
    const requestedPerZone = new Map(); // zoneKey -> count

    // Tarifs / prix indexés
    const prices = await TariffPrice.find({
      seasonCode, venueSlug, isActive: true,
      $or: [
        { zoneKey: { $in: TBH7_ZONE_KEYS } },
        { zoneKey: '*' }
      ]
    }).lean();
    const pricesIdx = buildPricesIndex(prices);

    // Validation et préparation des lignes (pas de seatId imposé en TBH7)
    const lines = [];
    for (const it of items) {
      const zoneKey = norm(it.zoneKey || (it.seatId ? String(it.seatId).split('-')[0] : ''));
      if (!zoneKey || !zoneMap.has(zoneKey)) {
        return res.status(400).json({ error: 'invalid_zone', zoneKey });
      }
      const tariffCode = upper(it.tariffCode || '');
      if (!tariffCode) {
        return res.status(400).json({ error: 'invalid_tariff' });
      }

      const priceCents = getPriceCents(pricesIdx, zoneKey, tariffCode);
      lines.push({
        seatId: null,             // TBH7: pas de siège à la ligne
        zoneKey,
        holderFirstName: norm(it.firstName || ''),
        holderLastName:  norm(it.lastName  || ''),
        tariffCode,
        priceCents,
        justif: norm(it.justif || ''),
        info:   norm(it.info   || '')
      });

      requestedPerZone.set(zoneKey, (requestedPerZone.get(zoneKey) || 0) + 1);
    }

    // Contrôle quotas: conso existante + demande <= quota (ou capacity si quota=0)
    const usage = await computeZoneUsage({ seasonCode, venueSlug });
    for (const [zoneKey, count] of requestedPerZone) {
      const z = zoneMap.get(zoneKey);
      const used = usage.get(zoneKey) || 0;
      const quota    = Number(z.quota || 0);
      const capacity = Number(z.capacity || 0);
      const plafond  = quota > 0 ? quota : capacity; // si quota non défini, fallback capacity
      if (plafond > 0 && (used + count) > plafond) {
        return res.status(409).json({
          error: 'quota_exceeded',
          zoneKey,
          remaining: Math.max(0, plafond - used)
        });
      }
    }

    const totalCents = lines.reduce((acc, l) => acc + Number(l.priceCents || 0), 0);

    // Créer l'order
    const order = await Order.create({
      seasonCode,
      venueSlug,
      phase: 'subscription',
      groupKey: `TBH7-${seasonCode}`,
      payerFirstName: norm(payer.firstName || ''),
      payerLastName:  norm(payer.lastName  || ''),
      payerEmail:     norm(payer.email     || ''),
      paymentSplit:   schedule,
      lines,
      totalCents,
      status: 'pending',
      paymentProvider: PAYMENT_PROVIDER_ID,
      paymentProviderMeta: {},
origin: { flow: 'tbh7', uiPath: '/tbh7', apiPath: `${req.baseUrl||''}${req.path}` },
mailTemplateKind: 'tbh7',
phase: 'tbh7'
    });

    const urls = buildReturnUrls(order);
    const intent = await createCheckoutIntent({
      order,
      returnUrl: urls.returnUrl,
      backUrl: urls.backUrl,
      errorUrl: urls.errorUrl
    });
    const { redirectUrl, raw, error } = intent;
    if (error || !redirectUrl) {
      console.error('[tbh7] createCheckoutIntent failed:', error);
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
    console.error('[POST /api/tbh7/checkout] error:', e);
    return res.status(code).json({ error: e.message || 'internal_error' });
  }
});

export default router;
