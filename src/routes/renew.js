// src/routes/renew.js
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

import { Subscriber }  from '../models/Subscriber.js';
import { Seat }        from '../models/Seat.js';
import { Tariff }      from '../models/Tariff.js';
import { TariffPrice } from '../models/TariffPrice.js';
import { Order }       from '../models/Order.js';

import { createCheckoutIntent } from '../services/helloasso.js';
import { makeTokenHash } from '../utils/ha-token.js';
import { checkNoSingleGap } from '../utils/no-single-gap.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = process.env.APP_URL || '';
const HELLOASSO_STUB = String(process.env.HELLOASSO_STUB || 'false').toLowerCase() === 'true';
const STUB_RESULT = (process.env.HELLOASSO_STUB_RESULT || 'success').toLowerCase();

const HA_RETURN_URL = process.env.HELLOASSO_RETURN_URL || (APP_URL ? `${APP_URL}/ha/return` : '/ha/return');
const HA_BACK_URL   = HA_RETURN_URL.replace(/\/ha\/return(?:\/)?$/, '/ha/back');
const HA_ERR_URL    = HA_RETURN_URL.replace(/\/ha\/return(?:\/)?$/, '/ha/error');

// ---------- Helpers ----------
function zoneKeyFromSeatId(seatId) {
  const s = String(seatId || '');
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : s;
}
function decodeToken(id) {
  if (!id || !JWT_SECRET) return null;
  try { return jwt.verify(id, JWT_SECRET); }
  catch { return null; }
}
function normSeatId(s) { return String(s || '').trim(); }

function buildSeatSubscribersFromSeats(seats, existing = {}) {
  const out = { ...existing };
  for (const s of seats || []) {
    const sid = normSeatId(
      (typeof s === 'string') ? s : (s.seatId || s.id || s.label || '')
    );
    if (!sid) continue;

    if (!out[sid]) {
      // essaie différentes conventions de champs
      const firstName = s.holderFirstName || s.firstName || s.subscriber?.firstName || '';
      const lastName  = s.holderLastName  || s.lastName  || s.subscriber?.lastName  || '';
      const email     = s.holderEmail     || s.email     || s.subscriber?.email     || '';
      if (firstName || lastName || email) {
        out[sid] = { firstName, lastName, email };
      }
    }
  }
  return out;
}

// Construit un index (zoneKey|tariffCode -> priceCents)
function buildPricesIndex(prices) {
  const idx = new Map();
  for (const p of prices || []) {
    const z = String(p.zoneKey || p.zone || '').toUpperCase();
    const t = String(p.tariffCode || p.tariff || '').toUpperCase();
    if (!z || !t) continue;
    idx.set(`${z}|${t}`, Number(p.priceCents || 0));
  }
  return idx;
}
function getPriceCents(pricesIdx, zoneKey, tariffCode) {
  const z = String(zoneKey || '').toUpperCase();
  const t = String(tariffCode || '').toUpperCase();
  return pricesIdx.get(`${z}|${t}`) ?? 0;
}

// ---------- GET /s/renew?id=<jwt> ----------
/**
 * Répond au front avec les données nécessaires pour l’écran Renew.
 * Sortie: { season, seasonCode, venue, venueSlug, tariffs, prices, seats, tokenSeats, seatSubscribers, payer, blockedAny, blockedSeats }
 */
router.get('/renew', async (req, res) => {
  try {
    const id  = req.query.id || '';
    const tok = decodeToken(id);
    if (!tok || !tok.seasonCode || !tok.venueSlug || !tok.seatIds?.length) {
      return res.status(400).json({ error: 'missing_or_invalid_token' });
    }
    const { seasonCode, venueSlug, seatIds } = tok;
    const tokenSet = new Set(seatIds.map(normSeatId));

    // Tarifs & prix
    const tariffs = await Tariff.find({ seasonCode, venueSlug, isActive: true }).lean();
    const prices  = await TariffPrice.find({ seasonCode, venueSlug, isActive: true }).lean();

    // Sièges du token (dans la salle)
    const seats = await Seat.find({ seasonCode, venueSlug, seatId: { $in: seatIds } }).lean();

    // Abonnés liés aux sièges du token
    // (NB: pas de champ seatId dans le modèle; on matche sur prefSeatId et previousSeasonSeats)
    const subs = await Subscriber.find(
      {
        seasonCode, venueSlug,
        $or: [
          { prefSeatId: { $in: seatIds } },
          { previousSeasonSeats: { $in: seatIds } }
        ]
      },
      // projection minimale utile
      'firstName lastName email prefSeatId previousSeasonSeats'
    ).lean();

    // Map { seatIdDuToken -> {firstName,lastName,email} }
    const seatSubscribersRaw = {};
    for (const s of subs || []) {
      const pref = normSeatId(s.prefSeatId);
      let match = pref && tokenSet.has(pref) ? pref : null;
      if (!match && Array.isArray(s.previousSeasonSeats)) {
        match = s.previousSeasonSeats.map(normSeatId).find(x => tokenSet.has(x)) || null;
      }
      if (!match) continue;
      seatSubscribersRaw[match] = {
        firstName: s.firstName || '',
        lastName:  s.lastName  || '',
        email:     s.email     || ''
      };
    }

    // Compléter depuis seats (au cas où certains holders seraient recopiés côté Seat)
    const seatSubscribers = buildSeatSubscribersFromSeats(seats, seatSubscribersRaw);

    // Payer par défaut : d'abord celui du premier seatId du token, sinon le premier dispo, sinon vide
    let payer = {
      firstName: seatSubscribers?.[seatIds[0]]?.firstName || '',
      lastName : seatSubscribers?.[seatIds[0]]?.lastName  || '',
      email    : seatSubscribers?.[seatIds[0]]?.email     || ''
    };
    if (!(payer.firstName || payer.lastName || payer.email)) {
      const any = Object.values(seatSubscribers)[0];
      if (any) {
        payer = {
          firstName: any.firstName || '',
          lastName : any.lastName  || '',
          email    : any.email     || ''
        };
      }
    }

    // Statuts bloqués (info UI)
    const blockedSeats = seats
      .filter(s => s.status && String(s.status).toLowerCase() !== 'available')
      .map(s => s.seatId);
    const blockedAny = blockedSeats.length > 0;

    return res.json({
      season: seasonCode, seasonCode,
      venue : venueSlug,  venueSlug,
      tariffs, prices, seats,
      tokenSeats: seatIds,
      seatSubscribers,   // ← rempli à partir de prefSeatId / previousSeasonSeats
      payer,             // ← renseigné si possible
      blockedAny,
      blockedSeats
    });
  } catch (e) {
    console.error('[GET /s/renew] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});


// ---------- POST /s/renew?id=<jwt> ----------
/**
 * Reçoit le panier Renew et crée l’Order + intent HelloAsso.
 * Body: { items:[{seatId, lastName, firstName, tariffCode, justif?, info?}, ...], payer:{firstName,lastName,email}, schedule:1|2|3 }
 * Réponse: { ok:true, orderId, totalCents, redirectUrl }
 */
router.post('/renew', async (req, res) => {
  try {
    const id  = req.query.id || '';
    const tok = decodeToken(id);
    if (!tok || !tok.seasonCode || !tok.venueSlug || !tok.seatIds?.length) {
      return res.status(400).json({ error: 'missing_or_invalid_token' });
    }

    const { seasonCode, venueSlug, seatIds: allowedSeatIds } = tok;
    const items    = Array.isArray(req.body.items) ? req.body.items : [];
    const payer    = req.body.payer || {};
    const schedule = Number(req.body.schedule || 1);

    if (!items.length)        return res.status(400).json({ error: 'empty_items' });
    if (!payer?.email)        return res.status(400).json({ error: 'payer_email_required' });
    if (![1,2,3].includes(schedule)) return res.status(400).json({ error: 'invalid_schedule' });

    // Sièges vraiment demandés
    const seatIdsAsked = [...new Set(items.map(i => normSeatId(i.seatId)))];
    // Chaque siège demandé doit être dans le token
    for (const sid of seatIdsAsked) {
      if (!allowedSeatIds.includes(sid)) {
        return res.status(403).json({ error: 'seat_not_in_token', seatId: sid });
      }
    }

    // Prix (index)
    const prices   = await TariffPrice.find({ seasonCode, venueSlug, isActive: true }).lean();
    const pricesIx = buildPricesIndex(prices);

    // Construire les lignes + total
    const lines = [];
    let totalCents = 0;
    for (const it of items) {
      const seatId = normSeatId(it.seatId);
      const zoneKey = zoneKeyFromSeatId(seatId);
      const tariffCode = String(it.tariffCode || '').toUpperCase();
      const priceCents = getPriceCents(pricesIx, zoneKey, tariffCode);

      lines.push({
        seatId,
        zoneKey,
        holderFirstName: String(it.firstName || ''),
        holderLastName:  String(it.lastName  || ''),
        tariffCode,
        priceCents,
        justif: String(it.justif || ''),
        info:   String(it.info   || '')
      });
      totalCents += Number(priceCents || 0);
    }


  // ----- RÈGLE "NO SINGLE GAP" -----
  {
    const realSeatIds = lines.map(l => l.seatId).filter(Boolean);
    if (realSeatIds.length > 1) {
      const gap = await checkNoSingleGap({ seasonCode, venueSlug, seatIds: realSeatIds });
      if (gap) {
        return res.status(422).json({
          error: 'single_gap_rule',
          zoneKey: gap.zoneKey,
          rowKey:  gap.rowKey,
          seatIdLeft:  gap.leftSeatId,
          seatIdRight: gap.rightSeatId,
          gapSeatId:   gap.gapSeatId
        });
      }
    }
  }


    // Créer la commande (pending)
    const order = await Order.create({
      seasonCode,
      venueSlug,
      phase: 'renew',
      groupKey: `RENEW-${seasonCode}`, // regroupement fonctionnel
      payerFirstName: String(payer.firstName || ''),
      payerLastName:  String(payer.lastName  || ''),
      payerEmail:     String(payer.email     || ''),
      paymentSplit:   schedule,
      lines,
      totalCents,
      status: 'pending',
      paymentProvider: 'helloasso',
      paymentProviderMeta: {},               // ← standard HELLOASSO
      origin: {
        flow:   'renew',
        uiPath: '/renew',
        apiPath:`${req.baseUrl || ''}${req.path}`
      },
      mailTemplateKind: 'renew'
    });

    // STUB (DEV) : pas d'appel réseau, on génère un intentId local + tokenHash
    if (HELLOASSO_STUB) {
      const intentId  = `stub-${Date.now()}`;
      const tokenHash = makeTokenHash({ orderId: order._id, checkoutIntentId: intentId });

      order.paymentProviderMeta = {
        ...(order.paymentProviderMeta || {}),
        checkoutIntentId: intentId,
        tokenHash
      };
      await order.save();

      const ok = STUB_RESULT === 'success' || STUB_RESULT === 'ok' || STUB_RESULT === 'true' || STUB_RESULT === '1';
      const redirectUrl = `${HA_RETURN_URL}?oid=${order._id}&ci=${intentId}&h=${tokenHash}&stub=1&result=${ok ? 'success' : 'failure'}`;
      return res.json({ ok: true, orderId: order._id, totalCents, redirectUrl });
    }

    // SANDBOX/PROD : crée un CheckoutIntent HelloAsso
    // ➜ Ajoute ?oid=<OrderId> aux URLs de retour pour la corrélation au /ha/return
    const withOID = (u, oid) => u + (u.includes('?') ? '&' : '?') + `oid=${encodeURIComponent(String(oid))}`;
    const retUrl  = withOID(HA_RETURN_URL, order._id);
    const backUrl = withOID(HA_BACK_URL,   order._id);
    const errUrl  = withOID(HA_ERR_URL,    order._id);

    const { redirectUrl, raw, error } = await createCheckoutIntent({
      order,
      returnUrl: retUrl,
      backUrl:   backUrl,
      errorUrl:  errUrl
    });

    if (error || !redirectUrl) {
      console.error('[renew] createCheckoutIntent failed:', error);
      return res.status(502).json({ error: 'helloasso_unavailable' });
    }

    // Persist intent + tokenHash pour le retour /ha/return
    if (raw?.id) {
      const tokenHash = makeTokenHash({ orderId: order._id, checkoutIntentId: raw.id });
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
    console.error('[POST /s/renew] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
