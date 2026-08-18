// src/routes/renew.js
import express from 'express';
import jwt from 'jsonwebtoken';

import { Subscriber }  from '../models/Subscriber.js';
import { Seat }        from '../models/Seat.js';
import { Tariff }      from '../models/Tariff.js';
import { TariffPrice } from '../models/TariffPrice.js';
import { Order }       from '../models/Order.js';

import { createCheckoutIntent, buildReturnUrls, currentPaymentProviderId } from '../services/payments/index.js';
import { makeTokenHash } from '../utils/ha-token.js';
import { findSingleGaps }      from '../utils/no-single-gap.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const PAYMENT_PROVIDER_ID = currentPaymentProviderId();

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

// Same helpers as event-flow.factory.js — the checkout response needs
// providerUrl+statusUrl or the shared order/index.ejs client (generic-view.js)
// never opens the active-polling booking-status panel and falls back to a
// bare full-page redirect + /pay/return's slow 8s self-refresh.
function buildPayStartUrl(orderId) {
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

// Which seatIds from this renewal token are already covered by a paid/tobepaid
// order? Real seats already get this via Seat.status, but a standing-zone
// virtual seat (e.g. "FAN_ZONE-Z001") has no Seat document at all — nothing
// else can tell a second checkout attempt that the slot was already renewed.
async function alreadyPaidSeatIdsForToken({ seasonCode, venueSlug, seatIds }) {
  const orders = await Order.find(
    {
      seasonCode, venueSlug,
      'origin.flow': { $in: ['subscription', 'renew'] },
      status: { $in: ['paid', 'tobepaid'] },
      'lines.seatId': { $in: seatIds }
    },
    { 'lines.seatId': 1 }
  ).lean();
  const covered = new Set();
  for (const ord of orders) {
    for (const line of (ord.lines || [])) {
      const sid = normSeatId(line?.seatId);
      if (sid && seatIds.includes(sid)) covered.add(sid);
    }
  }
  return covered;
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

    // Statuts bloqués (info UI) — sièges réels déjà occupés...
    const blockedFromSeats = seats
      .filter(s => s.status && String(s.status).toLowerCase() !== 'available')
      .map(s => s.seatId);
    // ...+ sièges virtuels de zone (debout) déjà couverts par une commande payée :
    // il n'existe aucun Seat pour ces id, donc rien d'autre ne peut détecter qu'un
    // renouvellement debout a déjà été honoré — sans ce contrôle, un lien de
    // renouvellement reste indéfiniment réutilisable et peut créer des commandes
    // payées en double pour la même place.
    const alreadyPaidSeatIds = await alreadyPaidSeatIdsForToken({ seasonCode, venueSlug, seatIds });
    const blockedSeats = Array.from(new Set([...blockedFromSeats, ...alreadyPaidSeatIds]));
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
 * Reçoit le panier Renew et crée l’Order + intent chez le prestataire de paiement.
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

    // Un lien de renouvellement reste valable jusqu'à son expiration JWT — sans
    // ce contrôle, le rouvrir après un renouvellement déjà payé (ou un double
    // clic) crée une seconde commande payée pour la même place. Pour un siège
    // réel, la vérif seatStatus (holdable/conflit) plus bas fait déjà ce travail ;
    // ceci couvre en plus les places de zone debout, qui n'ont pas de Seat.
    const alreadyPaidAsked = await alreadyPaidSeatIdsForToken({ seasonCode, venueSlug, seatIds: seatIdsAsked });
    if (alreadyPaidAsked.size) {
      return res.status(409).json({ error: 'already_renewed', seatIds: Array.from(alreadyPaidAsked) });
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


    // 🚫 RÈGLE ANTI-TROU (serveur) — contrôle avant création de l'order
    //    Ne considère que les lignes "siège" (les zones virtuelles n'existent pas en Renew)
    /*{
      const seatIdsAsked = lines.map(l => l.seatId).filter(Boolean);
      const gaps = await findSingleGaps({ seasonCode, venueSlug, selectedSeatIds: seatIdsAsked });
      if (gaps.length) {
        const g = gaps[0];
        return res.status(409).json({
          error: 'no_single_gap',
          message: `Votre sélection créerait un siège isolé en rangée ${g.row} (zone ${g.zoneKey}).`,
          problems: gaps
        });
      }
    }*/


    // Créer la commande (pending)
    const order = await Order.create({
      itemName:`RENEW_${seasonCode}`,
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
      paymentProvider: PAYMENT_PROVIDER_ID,
      paymentProviderMeta: {},
      origin: {
        flow:   'renew',
        uiPath: '/renew',
        apiPath:`${req.baseUrl || ''}${req.path}`
      },
      mailTemplateKind: 'renew'
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
      console.error('[renew] createCheckoutIntent failed:', error);
      return res.status(502).json({ error: 'payment_unavailable' });
    }

    // Persist intent + tokenHash pour le retour /pay/return
    const checkoutId = String(intent?.id || intent?.checkoutReference || raw?.id || raw?.checkout_reference || '');
    if (checkoutId) {
      const checkoutReference = raw?.checkout_reference || intent?.checkoutReference || checkoutId;
      const tokenHash = makeTokenHash({ orderId: order._id, checkoutIntentId: checkoutId });
      order.paymentProviderMeta = {
        ...(order.paymentProviderMeta || {}),
        name: PAYMENT_PROVIDER_ID,
        checkoutIntentId: checkoutId,
        checkoutReference,
        providerRedirectUrl: redirectUrl || null,
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

    return res.json({
      ok: true,
      orderId: order._id,
      totalCents,
      redirectUrl: buildPayStartUrl(order._id),   // /pay/start (legacy fallback)
      providerUrl: redirectUrl,                    // direct provider URL (SumUp hosted checkout)
      statusUrl:   buildPayStatusUrl(order._id),   // polling endpoint
      returnUrl:   buildPayReturnUrl(order._id, checkoutId)
    });
  } catch (e) {
    console.error('[POST /s/renew] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
