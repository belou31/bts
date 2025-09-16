// src/routes/event.js
import { Router } from 'express';
import assert from 'node:assert/strict';
import mongoose, { isValidObjectId } from 'mongoose';

import { Event } from '../models/Event.js';          // ton modèle existant
import { Seat } from '../models/Seat.js';            // supposé existant (utilisé par abonnement)
import { Order } from '../models/Order.js';          // supposé existant
import { Tariff } from '../models/Tariff.js';        // supposé existant
import { TariffPrice } from '../models/TariffPrice.js'; // supposé existant
import { Zone } from '../models/Zone.js';
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

// Charge tarifs/prix : priorité à la table "évènement".
// Si AUCUN tarif d'évènement n'existe, fallback sur saison/lieu (mode legacy).
async function loadTariffsAndPrices(ev){
  const evTariffs = await Tariff.find({ priceTableKey: ev.priceTableKey, active: true }).lean();
  if (evTariffs.length > 0) {
    const evPrices = await TariffPrice.find({ priceTableKey: ev.priceTableKey }).lean();
    return { tariffs: evTariffs, prices: evPrices, scope: 'event' };
  }
  const fbTariffs = await Tariff.find({ seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, active: true }).lean();
  const fbPrices  = await TariffPrice.find({ seasonCode: ev.seasonCode, venueSlug: ev.venueSlug }).lean();
  return { tariffs: fbTariffs, prices: fbPrices, scope: 'fallback' };
}

function buildAllowedFromPrices(prices){
  const map = new Map(); // ZONEKEY(UPPER) -> Set(TARIFF UPPER)
  for (const p of (prices||[])) {
    const z = String(p.zoneKey||'').toUpperCase();
    const t = String(p.tariffCode||'').toUpperCase();
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
    const [seatsBase, { tariffs, prices, scope }] = await Promise.all([
      computeSeatStates(ev),
      loadTariffsAndPrices(ev)
    ]);

    // 1) Zones autorisées à partir des prix (UPPERCASE partout)
    const { allowedZones, allowedTariffsByZone } = buildAllowedFromPrices(prices);
    let allowedSet = new Set((allowedZones || []).map(z => String(z).toUpperCase()));

    // 2) Récupère zones PUBLIC actives + construit zonesMeta { KEY: name }
    let zonesMeta = {};
    let zonesKind = {}; // { KEY: 'seated'|'standing'|'fanclub' }
    try {
      const publics = await Zone.find(
        { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, access: 'PUBLIC', isActive: true },
        { key: 1, name: 1, type: 1, _id: 0 }
    ).lean();
      if (Array.isArray(publics) && publics.length > 0) {
        const publicSet = new Set(publics.map(z => String(z.key).toUpperCase()));
        allowedSet = new Set([...allowedSet].filter(z => publicSet.has(String(z).toUpperCase())));
        zonesMeta = publics.reduce((acc, z) => {
          const K = String(z.key || '').toUpperCase();
          acc[K] = z.name || K;
          return acc;
        }, {});
        zonesKind = publics.reduce((acc, z) => {
          const K = String(z.key || '').toUpperCase();
          acc[K] = z.type || 'seated';
          return acc;
        }, {});
      }
    } catch { /* ignore filtre zones */ }

    // 3) Marque les sièges sélectionnables (status available + zone autorisée)
    const seatsOut = (seatsBase || []).map(s => ({
      ...s,
      allowed:
        (String(s.status || '').toLowerCase() === 'available') &&
        allowedSet.has(String(s.zoneKey || '').toUpperCase())
    }));

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
      seats: seatsOut
    });
  } catch (e) {
    res.status(404).json({ ok: false, error: e.message || 'Not found' });
  }
});

// POST /api/event/:eventId/checkout
router.post('/:eventId/checkout', async (req, res) => {
  try {
    const ev = await loadEvent(req.params.eventId);
    assert(ev.isOnSale === true, 'Vente fermée pour cet événement.');

    const { payer, items, schedule } = req.body || {};
    assert(Array.isArray(items) && items.length > 0, 'Panier vide');

    // ⚠️ On n’impose la vérif de siège que si seatId est présent
    const seats = await computeSeatStates(ev);
    const statusIdx = new Map(seats.map(s => [String(s.seatId), s.status]));
    for (const it of items) {
      const sid = String(it.seatId||'').trim();
      if (!sid) continue; // ligne "zone" (ex: DEBOUT) → pas de check siège
      const st  = statusIdx.get(sid) || 'available';
      assert(st === 'available', `Siège indisponible: ${sid} (${st})`);
    }

    // Recalcule prix (table évènement si elle existe, sinon fallback)
    const { prices, scope } = await loadTariffsAndPrices(ev);
    const pmap = new Map(prices.map(p => [
      `${String(p.zoneKey||'').toUpperCase()}::${String(p.tariffCode||'').toUpperCase()}`,
      Number(p.priceCents)||0
    ]));
    const lines = items.map(it => {
      const z = String(it.zoneKey||'').toUpperCase();
      const t = String(it.tariffCode||'').toUpperCase();
      const sid = String(it.seatId||'').trim() || null;
      const key = `${z}::${t}`;
    // 🛑 Interdit: tarif absent pour la zone dans la table retenue
      if (!pmap.has(key)) {
        throw new Error(`Tarif indisponible pour la zone (${z}/${t})${scope==='fallback'?' [fallback]':''}`);
      }
      return {
        seatId:   sid,                // peut être null pour une ligne "zone"
        zoneKey:  z,
        tariff:   t,
       amountCents: pmap.get(key)
      };
    });
    const totalCents = lines.reduce((s, l) => s + (Number(l.amountCents)||0), 0);
    assert(totalCents > 0, 'Montant total nul (tarifs manquants ?)');

    
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
    totalCents,
    meta: {
      eventId: String(ev._id),
      eventSlug: ev.slug,
      eventName: ev.name,
      seasonCode: ev.seasonCode,
      venueSlug: ev.venueSlug,
      provider:'helloasso'
    },
      hold: { until }
    });

    // Pose des holds uniquement pour les lignes avec seatId réel
    const holdable = lines.filter(ln => !!ln.seatId);
    if (holdable.length) {
      await Promise.all(holdable.map(ln =>
        Seat.updateOne(
          { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, seatId: ln.seatId, status: { $ne: 'booked' } },
          { $set: { status:'busy', 'meta.hold': { orderId: String(ord._id), until } } }
        )
      ));
    }

    // Intent paiement (HelloAsso ou STUB)
    let intent = null;
    try {
      const retUrl = process.env.HELLOASSO_RETURN_URL || '';
      intent = await HA.createCheckoutIntent({
        amountCents: totalCents,
        metadata: { orderId: String(ord._id), eventId: String(ev._id) },
        returnUrl: retUrl
      });
    } catch (err) {
      // En DEV, si HELLOASSO_STUB=true, on renvoie un faux redirect pour tester le flux bout-en-bout
      if (String(process.env.HELLOASSO_STUB||'').toLowerCase() === 'true') {
        const appUrl = process.env.APP_URL || '';
        intent = { redirectUrl: `${appUrl.replace(/\/$/,'')}/ha/return?stub=1&ok=1&orderId=${ord._id}` };
      } else {
        throw new Error(`HelloAsso indisponible: ${err.message||err}`);
      }
    }

    res.json({ ok:true, orderId:String(ord._id), checkout:intent });
  } catch (e) {
    console.error('[event/checkout] error:', e?.message || e);
    res.status(400).json({ ok:false, error: e.message||'Checkout error' });
  }
});

export default router;
