// src/routes/tbh7.js
import { Router } from 'express';
import mongoose from 'mongoose';

import { Season }      from '../models/Season.js';
import { Zone }        from '../models/Zone.js';
import { Tariff }      from '../models/Tariff.js';
import { TariffPrice } from '../models/TariffPrice.js';
import { Order }       from '../models/Order.js';
import { createCheckoutIntent } from '../services/helloasso.js';
import { makeTokenHash } from '../utils/ha-token.js';


const router = Router();

// -------------------------- helpers --------------------------

const truthy = v => String(v ?? '').toLowerCase() === 'true';
const stripTrailingSlash = s => (s || '').replace(/\/+$/, '');

async function getSeasonAndVenue(seasonHint) {
  if (seasonHint) {
    const s = await Season.findOne({ code: seasonHint }).lean();
    if (s?.code && s?.venueSlug) return { seasonCode: s.code, venueSlug: s.venueSlug };
  }
  const s = await Season.findOne({ active: true }).lean();
  if (!s?.code || !s?.venueSlug) {
    const err = new Error('No active season/venue');
    err.status = 503;
    throw err;
  }
  return { seasonCode: s.code, venueSlug: s.venueSlug };
}


async function getPricesForZones({ seasonCode, venueSlug, zoneKeys }) {
  // Récupère toutes les TariffPrice de la saison/lieu pour les zones demandées
  const tps = await TariffPrice.find({ seasonCode, venueSlug, zoneKey: { $in: zoneKeys } }).lean().exec();

  const tariffCodes = Array.from(new Set(tps.map(tp => tp.tariffCode)));
  const tariffs = await Tariff.find({ code: { $in: tariffCodes } }).lean().exec();

  // Maps pour métadonnées (aligné renew)
  const meta = new Map(
    tariffs.map(t => [
      t.code,
      {
        label: t.label || t.code,
        requiresField: !!t.requiresField,
        fieldLabel: t.fieldLabel || null,
        requiresInfo: t.requiresInfo || null
      }
    ])
  );

  // Regroupe par zone, en joignant les métadonnées du Tariff
  const byZone = new Map(zoneKeys.map(k => [k, []]));
  for (const tp of tps) {
    const m = meta.get(tp.tariffCode) || { label: tp.tariffCode };
    byZone.get(tp.zoneKey)?.push({
      code: tp.tariffCode,
      label: m.label,
      amountCents: Number(tp.priceCents || 0),
      requiresField: !!m.requiresField,
      fieldLabel: m.fieldLabel || null,
      requiresInfo: m.requiresInfo || null
    });
  }

  // Trie par label pour stabilité
  //for (const [k, arr] of byZone) arr.sort((a,b) => String(a.label).localeCompare(String(b.label), 'fr'));
  return byZone;
}


async function countZoneUsed({ seasonCode, zoneKey }) {
  // Commandes déjà payées (une ligne = 1 place)
  const paidAgg = await Order.aggregate([
    { $match: { seasonCode, phase: 'tbh7', status: 'paid' } },
    { $unwind: '$lines' },
    { $match: { 'lines.zoneKey': zoneKey } },
    { $group: { _id: null, qty: { $sum: 1 } } }
  ]);
  const paid = paidAgg[0]?.qty || 0;

  // Holds actifs (optionnel) si le modèle ZoneHold existe
  const ZoneHold = mongoose.models.ZoneHold;
  let held = 0;
  if (ZoneHold) {
    const now = new Date();
    const heldAgg = await ZoneHold.aggregate([
      { $match: { seasonCode, zoneKey, expiresAt: { $gt: now } } },
      { $group: { _id: null, qty: { $sum: '$qty' } } }
    ]);
    held = heldAgg[0]?.qty || 0;
  }

  return paid + held;
}

function buildHAUrls() {
  const appUrl    = stripTrailingSlash(process.env.APP_URL || '');
  const returnUrl = process.env.HELLOASSO_RETURN_URL || (appUrl ? `${appUrl}/ha/return` : '/ha/return');
  const backUrl   = process.env.HELLOASSO_BACK_URL   || returnUrl.replace(/\/ha\/return$/, '/ha/back');
  const errorUrl  = process.env.HELLOASSO_ERROR_URL  || returnUrl.replace(/\/ha\/return$/, '/ha/error');
  return { appUrl, returnUrl, backUrl, errorUrl };
}

// -------------------------- routes --------------------------

/**
 * GET /status?season=YYYY-YYYY
 * Retourne les zones Fan Club actives de la saison + tarifs/prix par zone
 */
router.get('/status', async (req, res) => {
  try {
    const seasonHint = (req.query.season || '').trim();
    const { seasonCode, venueSlug } = await getSeasonAndVenue(seasonHint);

    // Zones : on sélectionne type 'fanclub' (ex.: TBH7, TBH7-VIRAGE), actives
    const zones = await Zone.find({ seasonCode, isActive: true, type: 'fanclub' })
      .select('key name quota svgSelector')
      .lean().exec();

    const zoneKeys = zones.map(z => z.key);
    const pricesMap = await getPricesForZones({ seasonCode, venueSlug, zoneKeys });

    const out = zones.map(z => ({
      zoneKey: z.key,
      name: z.name || z.key,
      quota: Number(z.quota || 0),
      svgSelector: z.svgSelector || null,
      prices: pricesMap.get(z.key) || []
    }));

    res.json({ seasonCode, zones: out });
  } catch (err) {
    console.error('GET /api/tbh7/status error:', err);
    res.status(err.status || 500).json({ error: err.message || 'server_error' });
  }
});

/**
 * POST /checkout
 * body: {
 *   seasonCode,                 // optionnel (sinon saison active)
 *   campaignCode,               // ex. "TBH7-2025" (facultatif, on peut le déduire)
 *   payer: { firstName, lastName, email },
 *   paymentSplit,               // 1/2/3…
 *   items: [ { zoneKey, tariffCode, qty } ]
 * }
 */
router.post('/checkout', async (req, res) => {
  try {
    const { seasonCode: seasonHint, campaignCode, payer, paymentSplit = 1, items = [] } = req.body || {};
    if (!payer?.firstName || !payer?.lastName || !payer?.email) {
      return res.status(400).json({ error: 'payer_invalid' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items_required' });
    }

    const { seasonCode, venueSlug } = await getSeasonAndVenue(seasonHint);

    // Prépare le pricing par TariffPrice et vérifie quotas zone par zone
    let totalCents = 0;
    const lines = [];

    for (const it of items) {
      const zoneKey = String(it.zoneKey || '').trim();
      const tariffCode = String(it.tariffCode || '').trim().toUpperCase();
      const qty = Math.max(1, Number(it.qty || 0));

      if (!zoneKey || !tariffCode || !qty) {
        return res.status(400).json({ error: 'item_invalid', details: it });
      }

      const zone = await Zone.findOne({ seasonCode, key: zoneKey, isActive: true }).lean();
      if (!zone) return res.status(400).json({ error: 'zone_unknown', zoneKey });

      // Quota par zone (si 0 => illimité)
      const quota = Number(zone.quota || 0);
      if (quota > 0) {
        const used = await countZoneUsed({ seasonCode, zoneKey });
        const remaining = quota - used;
        if (remaining < qty) {
          return res.status(409).json({ error: 'quota_exceeded', zoneKey, remaining });
        }
      }

      // TariffPrice obligatoire
      const tp = await TariffPrice.findOne({ seasonCode, venueSlug, zoneKey, tariffCode }).lean();
      if (!tp) return res.status(400).json({ error: 'tariffprice_missing', zoneKey, tariffCode });

      for (let i = 0; i < qty; i++) {
        lines.push({
          zoneKey,
          tariffCode,
          priceCents: Number(tp.priceCents || 0)
        });
        totalCents += Number(tp.priceCents || 0);
      }
    }

    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return res.status(400).json({ error: 'invalid_total' });
    }

    // Déduit un campaignCode si non fourni (ex. TBH7-2025)
    const camp = campaignCode || (() => {
      const y = Number((seasonCode || '').split('-')[0] || new Date().getFullYear());
      return `TBH7-${y}`;
    })();

    // Crée la commande en "pending"
    const order = await Order.create({
      seasonCode,
      venueSlug,
      phase: 'fanclub', // ou 'fanclub' si tu préfères l’appellation générique
      groupKey: camp,
      payerFirstName: String(payer.firstName || ''),
      payerLastName:  String(payer.lastName  || ''),
      payerEmail:     String(payer.email     || ''),
      paymentSplit:   Number(paymentSplit) || 1,
      lines,
      totalCents,
      status: 'pending',
      paymentProvider: 'helloasso',
      paymentProviderMeta: {},
  origin: {
    flow:   'fanclub',                         // ⬅️ important
    uiPath: '/tbh7',                           // URL “page”
    apiPath: `${req.baseUrl || ''}${req.path}` // ex: "/api/tbh7/checkout"
  },
  mailTemplateKind: 'fanclub'

    });

    // URLs de retour HelloAsso
    const { returnUrl, backUrl, errorUrl } = buildHAUrls();

    // Mode STUB (DEV) : on simule une redirection finale /ha/return
    const useStub = truthy(process.env.HELLOASSO_STUB || process.env.STUB);
    if (useStub) {
      const intentId = `stub-${Date.now()}`;
      const tokenHash = makeTokenHash({ orderId: order._id, checkoutIntentId: intentId });
      
      order.paymentProviderMeta = { ...(order.paymentProviderMeta || {}), checkoutIntentId: intentId, tokenHash };
      await order.save();

      const ok = String(process.env.HELLOASSO_STUB_RESULT || process.env.SUCCESS || 'success').toLowerCase() === 'success';
      const result = ok ? 'success' : 'failure';
      const redirectUrl = `${returnUrl}?oid=${order._id}&ci=${intentId}&h=${tokenHash}&stub=1&result=${result}`;
      return res.json({ ok: true, orderId: order._id, totalCents, redirectUrl });
    }

    // INT/PROD : flux HelloAsso réel (identique à renew)
    const { redirectUrl, raw, error } = await createCheckoutIntent({
      order,
      returnUrl,
      backUrl,
      errorUrl
    });
    if (error || !redirectUrl) {
      console.error('[tbh7] createCheckoutIntent error:', error);
      return res.status(502).json({ error: 'payment_intent_error' });
    }
    if (raw?.id) {
      const tokenHash = makeTokenHash({ orderId: order._id, checkoutIntentId: raw.id });
      order.paymentProviderMeta = { ...(order.paymentProviderMeta || {}), checkoutIntentId: raw.id, tokenHash };
      await order.save();
    }

    res.json({ ok: true, orderId: order._id, totalCents, redirectUrl });
  } catch (err) {
    console.error('POST /api/tbh7/checkout error:', err);
    res.status(err.status || 500).json({ error: err.message || 'server_error' });
  }
});

export default router;
