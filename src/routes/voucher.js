// src/routes/voucher.js
//
// Retrait d'un bon cadeau (API). Le bénéficiaire arrive par un QR imprimé,
// choisit un match éligible, puis ses places — comme /renew, mais le droit
// porté par le lien est un SOLDE plutôt qu'une liste de sièges.
//
// Aucun paiement n'intervient : les lignes sont à 0 et la commande porte
// origin.flow='voucher', pour qu'un bon ne fabrique jamais de chiffre d'affaires
// dans les exports.

import express from 'express';
import mongoose from 'mongoose';

import { Event } from '../models/Event.js';
import { Order } from '../models/Order.js';
import { SeatHold } from '../models/SeatHold.js';
import { computeEventSeatStates } from '../services/event-seat-states.js';
import { claimEventSeatHolds } from '../services/event-seat-holds.js';
import { finalizePaidIfNoConflict, sendOrderAttestationIfNeeded } from '../services/order-finalization.js';
import { createCheckoutIntent, buildReturnUrls, currentPaymentProviderId } from '../services/payments/index.js';
import {
  loadPurchaseConfig,
  loadVoucherByToken,
  voucherUsability,
  remainingOf,
  listEligibleEvents,
  isEventEligible,
  allowanceForEvent,
  usedOnEvent,
  resolveAllowedZoneKeys
} from '../services/vouchers.js';

const router = express.Router();

const norm = (s) => String(s || '').trim();
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm(v));

function voucherPublicView(voucher) {
  return {
    code: voucher.code,
    label: voucher.label || '',
    remaining: remainingOf(voucher),
    total: Number(voucher.balance?.total || 0),
    used: Number(voucher.balance?.used || 0),
    maxPerEvent: Number(voucher.maxPerEvent || 0),
    expiresAt: voucher.expiresAt || null,
    status: voucher.status
  };
}

// ---------- GET /s/voucher?id=<jwt> — solde + matchs éligibles ----------
router.get('/voucher', async (req, res) => {
  try {
    const voucher = await loadVoucherByToken(req.query.id || '');
    if (!voucher) return res.status(400).json({ error: 'missing_or_invalid_token' });

    const usable = voucherUsability(voucher);
    const events = usable.ok ? await listEligibleEvents(voucher) : [];

    res.json({
      ok: true,
      voucher: voucherPublicView(voucher),
      usable: usable.ok,
      reason: usable.reason || null,
      events: events.map(ev => ({
        slug: ev.slug,
        name: ev.name || ev.slug,
        startsAt: ev.startsAt,
        venueSlug: ev.venueSlug,
        // Ce que ce bon peut encore prendre SUR CE MATCH (plafond compris).
        allowance: allowanceForEvent(voucher, ev.slug),
        alreadyTaken: usedOnEvent(voucher, ev.slug)
      }))
    });
  } catch (e) {
    console.error('[GET /s/voucher] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------- GET /s/voucher/event/:slug?id=<jwt> — plan + périmètre ----------
router.get('/voucher/event/:slug', async (req, res) => {
  try {
    const voucher = await loadVoucherByToken(req.query.id || '');
    if (!voucher) return res.status(400).json({ error: 'missing_or_invalid_token' });

    const usable = voucherUsability(voucher);
    if (!usable.ok) return res.status(409).json({ error: usable.reason });

    const ev = await Event.findOne({ slug: norm(req.params.slug) }).lean();
    if (!ev) return res.status(404).json({ error: 'event_not_found' });
    if (!(await isEventEligible(voucher, ev))) {
      return res.status(403).json({ error: 'event_not_eligible' });
    }

    const allowance = allowanceForEvent(voucher, ev.slug);
    const allowedZones = await resolveAllowedZoneKeys(voucher, {
      seasonCode: ev.seasonCode, venueSlug: ev.venueSlug
    });
    const states = await computeEventSeatStates(ev);

    // Hors périmètre → présenté comme indisponible : le plan reste lisible,
    // mais rien d'inéligible n'est cliquable.
    const seats = states.map(s => (
      allowedZones && !allowedZones.has(String(s.zoneKey || '').toUpperCase())
        ? { ...s, status: s.status === 'available' ? 'busy' : s.status, outOfScope: true }
        : s
    ));

    res.json({
      ok: true,
      // Champs attendus par generic-view.js pour résoudre et peindre le plan.
      seasonCode: ev.seasonCode,
      venueSlug: ev.venueSlug,
      venueView: ev.venueView || null,
      tariffs: [],
      prices: [],
      seats,
      event: {
        id: String(ev._id), slug: ev.slug, name: ev.name || ev.slug,
        startsAt: ev.startsAt, venueSlug: ev.venueSlug, venueView: ev.venueView || null
      },
      voucher: voucherPublicView(voucher),
      allowance,
      allowedZones: allowedZones ? Array.from(allowedZones) : null
    });
  } catch (e) {
    console.error('[GET /s/voucher/event] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------- POST /s/voucher/redeem?id=<jwt> ----------
// Body: { eventSlug, seatIds: [], holder: { firstName, lastName, email } }
router.post('/voucher/redeem', async (req, res) => {
  let claimed = [];
  let eventDoc = null;
  try {
    const voucher = await loadVoucherByToken(req.query.id || '');
    if (!voucher) return res.status(400).json({ error: 'missing_or_invalid_token' });

    const usable = voucherUsability(voucher);
    if (!usable.ok) return res.status(409).json({ error: usable.reason });

    const eventSlug = norm(req.body?.eventSlug);
    const seatIds = [...new Set((Array.isArray(req.body?.seatIds) ? req.body.seatIds : []).map(norm).filter(Boolean))];
    const holder = req.body?.holder || {};
    const email = norm(holder.email);

    if (!eventSlug) return res.status(400).json({ error: 'missing_event' });
    if (!seatIds.length) return res.status(400).json({ error: 'empty_selection' });
    // Un email est exigé : c'est là que partent les billets, et cela laisse une
    // trace de qui a utilisé un titre au porteur.
    if (!isEmail(email)) return res.status(400).json({ error: 'email_required' });

    eventDoc = await Event.findOne({ slug: eventSlug }).lean();
    if (!eventDoc) return res.status(404).json({ error: 'event_not_found' });
    if (!(await isEventEligible(voucher, eventDoc))) {
      return res.status(403).json({ error: 'event_not_eligible' });
    }

    // Solde global ET plafond par match (Q1).
    const allowance = allowanceForEvent(voucher, eventSlug);
    if (seatIds.length > allowance) {
      return res.status(403).json({ error: 'allowance_exceeded', allowance, asked: seatIds.length });
    }

    // Périmètre de placement (Q3).
    const allowedZones = await resolveAllowedZoneKeys(voucher, {
      seasonCode: eventDoc.seasonCode, venueSlug: eventDoc.venueSlug
    });
    const states = await computeEventSeatStates(eventDoc);
    const stateById = new Map(states.map(s => [String(s.seatId), s]));

    for (const seatId of seatIds) {
      const st = stateById.get(seatId);
      if (!st) return res.status(400).json({ error: 'unknown_seat', seatId });
      if (allowedZones && !allowedZones.has(String(st.zoneKey || '').toUpperCase())) {
        return res.status(403).json({ error: 'zone_not_allowed', seatId, zoneKey: st.zoneKey });
      }
      if (st.status !== 'available') {
        return res.status(409).json({ error: 'seat_unavailable', seatId, status: st.status });
      }
    }

    // Verrou partagé avec l'achat : l'index unique {eventId, seatId} arbitre.
    const until = new Date(Date.now() + 5 * 60 * 1000);
    const order = new Order({
      itemName: `VOUCHER_${eventDoc.slug}`,
      seasonCode: eventDoc.seasonCode,
      venueSlug: eventDoc.venueSlug,
      eventId: eventDoc._id,
      // Unique par retrait : l'index uniq_paid_per_payer porte sur groupKey, et
      // un même bénéficiaire peut retirer plusieurs fois (Q4).
      groupKey: `VCH-${voucher.code}-${new mongoose.Types.ObjectId().toString()}`,
      payerFirstName: norm(holder.firstName),
      payerLastName: norm(holder.lastName),
      payerEmail: email,
      lines: seatIds.map(seatId => ({
        seatId,
        zoneKey: String(stateById.get(seatId)?.zoneKey || '').toUpperCase(),
        tariffCode: voucher.tariffCode || 'INVITATION',
        priceCents: 0,
        unitType: 'seat',
        holderFirstName: norm(holder.firstName),
        holderLastName: norm(holder.lastName)
      })),
      totalCents: 0,
      status: 'pending',
      origin: { flow: 'voucher', uiPath: '/voucher', apiPath: '/s/voucher/redeem' },
      mailTemplateKind: 'event',
      locale: req.locale,
      meta: {
        eventId: String(eventDoc._id),
        eventSlug: eventDoc.slug,
        eventName: eventDoc.name || eventDoc.slug,
        eventStartsAt: eventDoc.startsAt,
        voucherCode: voucher.code,
        voucherLabel: voucher.label || ''
      }
    });
    await order.save();

    const claim = await claimEventSeatHolds({
      ev: eventDoc, order, seatIds, sessionToken: '', until
    });
    claimed = claim.claimed;
    if (!claim.ok) {
      order.status = 'failed';
      await order.save();
      return res.status(409).json({ error: 'seat_unavailable', seatIds: claim.conflicts });
    }

    const finalized = await finalizePaidIfNoConflict(order);
    if (!finalized.ok) {
      order.status = 'failed';
      await order.save();
      await SeatHold.deleteMany({ orderId: order._id }).catch(() => {});
      return res.status(409).json({ error: 'seat_conflict', details: finalized.conflicts });
    }

    // Débit du bon APRÈS la réussite : un échec de placement ne doit pas
    // consommer des places.
    voucher.balance.used = Number(voucher.balance.used || 0) + seatIds.length;
    voucher.redemptions.push({
      orderId: order._id, eventSlug: eventDoc.slug, qty: seatIds.length,
      seatIds, at: new Date(), by: email
    });
    if (remainingOf(voucher) <= 0) voucher.status = 'spent';
    await voucher.save();

    let ticketsSent = false;
    try {
      ticketsSent = Boolean(await sendOrderAttestationIfNeeded(order, { force: true, source: 'voucher' }));
    } catch (err) {
      console.error('[voucher] ticket send failed:', err?.message || err);
    }

    res.json({
      ok: true,
      orderId: String(order._id),
      seatIds,
      ticketsSent,
      voucher: voucherPublicView(voucher)
    });
  } catch (e) {
    console.error('[POST /s/voucher/redeem] error:', e);
    if (claimed.length && eventDoc) {
      await SeatHold.deleteMany({ eventId: eventDoc._id, seatId: { $in: claimed } }).catch(() => {});
    }
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------- POST /s/voucher/purchase — achat d'un bon (amont) ----------
// Body: { places, recipient?, message?, buyer: { firstName, lastName, email } }
//
// Ne crée PAS le bon : il naît à la finalisation du paiement
// (issueVoucherForPurchase, appelé depuis order-finalization). Émettre ici
// offrirait des places avant d'avoir été payé.
router.post('/voucher/purchase', async (req, res) => {
  try {
    const cfg = loadPurchaseConfig();
    if (!cfg.enabled) return res.status(403).json({ error: 'purchase_disabled' });

    const places = Math.floor(Number(req.body?.places || 0));
    const buyer = req.body?.buyer || {};
    const email = norm(buyer.email);

    if (!Number.isFinite(places) || places < Number(cfg.minPlaces || 1) || places > Number(cfg.maxPlaces || 10)) {
      return res.status(400).json({ error: 'invalid_places', min: cfg.minPlaces, max: cfg.maxPlaces });
    }
    if (!isEmail(email)) return res.status(400).json({ error: 'email_required' });

    const unit = Number(cfg.pricePerPlaceCents || 0);
    if (!(unit > 0)) return res.status(500).json({ error: 'price_not_configured' });
    const totalCents = unit * places;

    const order = await Order.create({
      itemName: `VOUCHER_PURCHASE_${places}`,
      groupKey: `VCHBUY-${new mongoose.Types.ObjectId().toString()}`,
      payerFirstName: norm(buyer.firstName),
      payerLastName: norm(buyer.lastName),
      payerEmail: email,
      // Pas de ligne siège : un bon n'est rattaché à aucun match à l'achat.
      // C'est aussi ce qui le fait passer par la branche "sans siège" de la
      // finalisation, où le bon est émis.
      lines: [],
      totalCents,
      status: 'pending',
      origin: { flow: 'voucher-purchase', uiPath: '/voucher/buy', apiPath: '/s/voucher/purchase' },
      mailTemplateKind: 'public',
      locale: req.locale,
      meta: {
        voucherPlaces: places,
        voucherRecipient: norm(req.body?.recipient),
        voucherMessage: norm(req.body?.message),
        voucherUnitPriceCents: unit,
        // Périmètre figé à l'achat (voir issueVoucherForPurchase).
        voucherZones: cfg.allowedZones || [],
        voucherTags: cfg.tags || [],
        voucherSeasonCodes: cfg.seasonCodes || [],
        voucherMaxPerEvent: Number(cfg.maxPerEvent || 0)
      }
    });

    let intent = null;
    try {
      const urls = buildReturnUrls(order);
      intent = await createCheckoutIntent({
        order, returnUrl: urls.returnUrl, backUrl: urls.backUrl, errorUrl: urls.errorUrl
      });
    } catch (err) {
      order.status = 'failed';
      await order.save();
      return res.status(502).json({ error: 'payment_unavailable', detail: err?.message || String(err) });
    }

    const checkoutId = String(intent?.id || intent?.checkoutReference || '');
    order.paymentProvider = currentPaymentProviderId();
    order.paymentProviderMeta = {
      ...(order.paymentProviderMeta || {}),
      name: currentPaymentProviderId(),
      checkoutIntentId: checkoutId,
      providerRedirectUrl: intent?.redirectUrl || intent?.url || null
    };
    await order.save();

    res.json({
      ok: true,
      orderId: String(order._id),
      totalCents,
      providerUrl: intent?.redirectUrl || intent?.url || null
    });
  } catch (e) {
    console.error('[POST /s/voucher/purchase] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
