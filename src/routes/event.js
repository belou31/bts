// src/routes/event.js
import { Router } from 'express';
import assert from 'node:assert/strict';
import mongoose, { isValidObjectId } from 'mongoose';

import { Event } from '../models/Event.js';          // ton modèle existant
import { Seat } from '../models/Seat.js';            // supposé existant (utilisé par abonnement)
import { Order } from '../models/Order.js';          // supposé existant
import { Tariff } from '../models/Tariff.js';        // supposé existant
import { TariffPrice } from '../models/TariffPrice.js'; // supposé existant
import * as HA from '../services/helloasso.js';      // createCheckoutIntent/getCheckoutStatus

const router = Router();

const HOLD_MIN = Number(process.env.CHECKOUT_HOLD_MIN || '5');

async function loadEvent(eventIdOrSlug){
  const q = isValidObjectId(eventIdOrSlug)
    ? { $or:[{_id:new mongoose.Types.ObjectId(eventIdOrSlug)}, {slug:String(eventIdOrSlug)}] }
    : { slug: String(eventIdOrSlug) };
  const ev = await Event.findOne(q).lean();
  if (!ev) throw new Error('Event not found');
  return ev;
}

async function loadTariffsAndPrices(ev){
  const tariffs = await Tariff.find({
    $or: [
      { priceTableKey: ev.priceTableKey },
      { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug }
    ]
  }).lean();

  const prices = await TariffPrice.find({
    $or: [
      { priceTableKey: ev.priceTableKey },
      { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug }
    ]
  }).lean();

  return { tariffs, prices };
}

async function computeSeatStates(ev){
  // Base: états des sièges pour la saison/lieu (provisions/holds abonnements, VIP, etc.)
  const base = await Seat.find(
    { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug },
    { seatId:1, zoneKey:1, status:1, _id:0 }
  ).lean();

  const byId = new Map(base.map(s => [String(s.seatId), { seatId:s.seatId, zoneKey:s.zoneKey, status:String(s.status||'available').toLowerCase() }]));

  // Surcouche: ordres paid pour CET évènement -> booked
  const paid = await Order.find(
    { 'meta.eventId': String(ev._id), status:'paid' },
    { 'lines.seatId':1, _id:0 }
  ).lean();

  for (const ord of (paid||[])) {
    for (const ln of (ord.lines||[])) {
      const sid = String(ln.seatId||'');
      if (!sid) continue;
      const rec = byId.get(sid) || { seatId:sid, zoneKey:null, status:'available' };
      rec.status = 'booked';
      byId.set(sid, rec);
    }
  }

  return Array.from(byId.values());
}

// GET /api/event/:eventId/status
router.get('/:eventId/status', async (req, res) => {
  try {
    const ev = await loadEvent(req.params.eventId);
    const [seats, {tariffs, prices}] = await Promise.all([
      computeSeatStates(ev),
      loadTariffsAndPrices(ev)
    ]);

    res.json({
      ok: true,
      seasonCode: ev.seasonCode,
      venueSlug: ev.venueSlug,
      event: { id:String(ev._id), slug:ev.slug, name:ev.name, startsAt:ev.startsAt, isOnSale:ev.isOnSale },
      tariffs, prices,
      seats
    });
  } catch (e) {
    res.status(404).json({ ok:false, error: e.message||'Not found' });
  }
});

// POST /api/event/:eventId/checkout
router.post('/:eventId/checkout', async (req, res) => {
  try {
    const ev = await loadEvent(req.params.eventId);
    assert(ev.isOnSale === true, 'Vente fermée pour cet événement.');

    const { payer, items, schedule } = req.body || {};
    assert(Array.isArray(items) && items.length > 0, 'Panier vide');

    const seats = await computeSeatStates(ev);
    const statusIdx = new Map(seats.map(s => [String(s.seatId), s.status]));
    for (const it of items) {
      const sid = String(it.seatId||'').trim();
      assert(sid, 'seatId manquant');
      const st  = statusIdx.get(sid) || 'available';
      assert(st === 'available', `Siège indisponible: ${sid} (${st})`);
    }

    // Recalcule prix
    const { prices } = await loadTariffsAndPrices(ev);
    const pmap = new Map(prices.map(p => [`${String(p.zoneKey)}::${String(p.tariffCode).toUpperCase()}`, Number(p.priceCents)||0]));
    const lines = items.map(it => {
      const key = `${String(it.zoneKey)}::${String(it.tariffCode).toUpperCase()}`;
      return {
        seatId:   String(it.seatId),
        zoneKey:  String(it.zoneKey),
        tariff:   String(it.tariffCode).toUpperCase(),
        amountCents: pmap.get(key) || 0
      };
    });
    const totalCents = lines.reduce((s, l) => s + (Number(l.amountCents)||0), 0);

    // Crée order "pending" + hold
    const now = new Date();
    const until = new Date(now.getTime() + HOLD_MIN*60*1000);
    const ord = await Order.create({
      createdAt: now,
      status: 'pending',
      payer: {
        firstName: String(payer?.firstName||'').trim(),
        lastName:  String(payer?.lastName||'').trim(),
        email:     String(payer?.email||'').trim()
      },
      lines,
      schedule: Number(schedule||1),
      meta: { eventId: String(ev._id), eventSlug: ev.slug, provider:'helloasso' },
      hold: { until }
    });

    // Pose des holds
    await Promise.all(lines.map(ln =>
      Seat.updateOne(
        { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, seatId: ln.seatId, status: { $ne: 'booked' } },
        { $set: { status:'busy', 'meta.hold': { orderId: String(ord._id), until } } }
      )
    ));

    // Intent paiement
    const retUrl = process.env.HELLOASSO_RETURN_URL || '';
    const intent = await HA.createCheckoutIntent({
      amountCents: totalCents,
      metadata: { orderId: String(ord._id), eventId: String(ev._id) },
      returnUrl: retUrl
    });

    res.json({ ok:true, orderId:String(ord._id), checkout:intent });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message||'Checkout error' });
  }
});

export default router;
