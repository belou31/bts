// src/routes/subscription.js
import express from 'express';
import mongoose from 'mongoose'; // si pas déjà présent

import { Season }      from '../models/Season.js';
import { Seat }        from '../models/Seat.js';
import { Zone }        from '../models/Zone.js';
import { Tariff }      from '../models/Tariff.js';
import { TariffPrice } from '../models/TariffPrice.js';
import { Order }       from '../models/Order.js';

import { createCheckoutIntent } from '../services/helloasso.js';
import { makeTokenHash }        from '../utils/ha-token.js';
import { findSingleGaps }       from '../utils/no-single-gap.js';

const router = express.Router();

/* ====== ENV / Const ====== */
const APP_URL         = process.env.APP_URL || '';
const HELLOASSO_STUB  = String(process.env.HELLOASSO_STUB || 'false').toLowerCase() === 'true';
const STUB_RESULT     = (process.env.HELLOASSO_STUB_RESULT || 'success').toLowerCase();

const HA_RETURN_URL   = process.env.HELLOASSO_RETURN_URL || (APP_URL ? `${APP_URL}/ha/return` : '/ha/return');
const HA_BACK_URL     = HA_RETURN_URL.replace(/\/ha\/return(?:\/)?$/, '/ha/back');
const HA_ERR_URL      = HA_RETURN_URL.replace(/\/ha\/return(?:\/)?$/, '/ha/error');

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
  return { seasonCode, venueSlug };
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


/* ====== GET /api/sub/status ======
 * Répond: { seasonCode, venueSlug, tariffs[], prices[], seats[], zones[] }
 * zones[]: [{ key,name,quota,capacity,remaining,svgSelector }]
 */
router.get('/status', async (_req, res, next) => {
  try {
    const { seasonCode, venueSlug } = await getActiveSeasonAndVenue();

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
    const prices = await TariffPrice.find({
      seasonCode, venueSlug, isActive: true
    }).lean();
    const tariffs = await Tariff.find({
      seasonCode, venueSlug, isActive: true
    }).lean();

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

    res.json({ seasonCode, venueSlug, tariffs, prices, seats, zones: zonesOut });
  } catch (e) { next(e); }
});

/* ====== POST /api/sub/checkout ======
 * Body: {
 *   payer:{firstName,lastName,email},
 *   schedule:1|2|3,
 *   items:[{ seatId, zoneKey, firstName,lastName, tariffCode, justif?, info? }]
 * }
 * Accepte des lignes “siège” (seatId existant en BD) ET “zone” (seatId virtuel)
 */
router.post('/checkout', async (req, res) => {
  try {
    const { seasonCode, venueSlug } = await getActiveSeasonAndVenue();

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

    // Créer l’order
    const order = await Order.create({
      seasonCode, venueSlug,
      phase: 'subscription',
      groupKey: `SUBSCRIPTION-${seasonCode}`,
      payerFirstName: norm(payer.firstName || ''),
      payerLastName:  norm(payer.lastName  || ''),
      payerEmail:     norm(payer.email     || ''),
      paymentSplit:   schedule,
      lines, totalCents, status: 'pending',
      paymentProvider: 'helloasso',
      paymentProviderMeta: {},
      origin: { flow: 'subscription', uiPath: '/subscription', apiPath: `${req.baseUrl||''}${req.path}` },
      mailTemplateKind: 'subscription'
    });

    // HelloAsso (STUB en DEV)
    if (HELLOASSO_STUB) {
      const intentId  = `stub-${Date.now()}`;
      const tokenHash = makeTokenHash({ orderId: order._id, checkoutIntentId: intentId });
      order.paymentProviderMeta = { ...(order.paymentProviderMeta || {}), checkoutIntentId: intentId, tokenHash };
      await order.save();

      const ok = ['success','ok','true','1'].includes(STUB_RESULT);
      const redirectUrl = `${HA_RETURN_URL}?oid=${order._id}&ci=${intentId}&h=${tokenHash}&stub=1&result=${ok ? 'success' : 'failure'}`;
      return res.json({ ok: true, orderId: order._id, totalCents, redirectUrl });
    }

    // INT/PROD
    // Corrélation fiable au retour: ajoute ?oid=<orderId> aux 3 URLs
    const addOID = (u) => u + (u.includes('?') ? '&' : '?') + `oid=${encodeURIComponent(order._id.toString())}`;
    const { redirectUrl, raw, error } = await createCheckoutIntent({
      order,
      returnUrl: addOID(HA_RETURN_URL),
      backUrl:   addOID(HA_BACK_URL),
      errorUrl:  addOID(HA_ERR_URL)
    });

    if (error || !redirectUrl) {
      console.error('[subscription] createCheckoutIntent failed:', error);
      return res.status(502).json({ error: 'helloasso_unavailable' });
    }
    if (raw?.id) {
      const tokenHash = makeTokenHash({ orderId: order._id, checkoutIntentId: String(raw.id) });
      order.paymentProviderMeta = {
        ...(order.paymentProviderMeta || {}),
        name: 'helloasso',
        checkoutIntentId: String(raw.id),
        tokenHash
      };

      await order.save();
    }

    return res.json({ ok: true, orderId: order._id, totalCents, redirectUrl });
  } catch (e) {
    const code = e.status || 500;
    console.error('[POST /api/sub/checkout] error:', e);
    return res.status(code).json({ error: e.message || 'internal_error' });
  }
});

export default router;
