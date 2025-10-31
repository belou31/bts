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
import { createCheckoutIntent, buildReturnUrls, currentPaymentProviderId } from '../services/payments/index.js';
import { resolveLinePlacement } from '../utils/event-attendance.js';

const router = Router();
const PAYMENT_PROVIDER_ID = currentPaymentProviderId();

const HOLD_MIN = Number(process.env.CHECKOUT_HOLD_MIN || '5');
// Helper: reconnaît un ID virtuel de zone (ex: DEBOUT-Z001)
const isVirtualZoneSeatId = (sid) => /^.+-Z\d{3,}$/i.test(String(sid||''));
// Helper: reconnaît un vrai seatId (ZONE-ROW-###)
const isRealSeatId = (sid) => /^[A-Z0-9]+-[A-Z]+-\d{1,4}$/i.test(String(sid||''));

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
    {
      status: 'paid',
      $or: [
        { eventId: ev._id },
        { 'meta.eventId': String(ev._id) }
      ]
    },
    { lines: 1, _id: 0 }
  ).lean();

  for (const ord of (paid||[])) {
    for (const ln of (ord.lines||[])) {
      const placement = resolveLinePlacement(ln);
      if (placement.released) continue;
      const sid = String(placement.seatId||'').trim();
      if (!sid) continue;                 // lignes de zone → pas de seatId
      if (/-Z\d{3,}$/i.test(sid)) continue; // IDs virtuels (zones) → ignorer
      if (!byId.has(sid)) continue;       // ⛔ ne crée PAS de siège fantôme
      const rec = byId.get(sid);
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
    let publics = [];
    try {
      publics = await Zone.find(
        { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, access: 'PUBLIC', isActive: true },
        { key: 1, name: 1, type: 1, capacity: 1, quota: 1, _id: 0 }
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

    let standingZones = [];
    const standingDocs = (publics || []).filter(z => String(z.type || '').toLowerCase() === 'standing');
    if (standingDocs.length) {
      const zoneCapacity = new Map(standingDocs.map(z => {
        const key = String(z.key || '').toUpperCase();
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
          const key = String(placement.zoneKey || '').toUpperCase();
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
          const key = String(line?.zoneKey || '').toUpperCase();
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
      standingZones
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

    // Valide: lignes "siège" strictes, lignes "zone" (seatId vide) autorisées
    const seats = await computeSeatStates(ev);
    const statusIdx = new Map(seats.map(s => [String(s.seatId), s.status]));
    for (const it of items) {
      const sidRaw = String(it.seatId||'').trim();
      const sid = (sidRaw && statusIdx.has(sidRaw)) ? sidRaw : '';
      const z   = String(it.zoneKey||'').trim().toUpperCase();
      assert(z, 'zoneKey manquant');
      // ⚠️ Ne vérifier la dispo que pour les vrais sièges connus du plan.
      // (labels "Zone Debout" ou IDs virtuels ne sont pas dans statusIdx)
      // ✅ ne vérifier que si c’est un siège du plan (clé présente dans statusIdx)
      if (sid && statusIdx.has(sid)) {
        const st = statusIdx.get(sid) || 'available';
        assert(st === 'available', `Siège indisponible: ${sid} (${st})`);
      }
    }

    // Recalcule prix (table évènement si elle existe, sinon fallback)
    const { prices, scope } = await loadTariffsAndPrices(ev);
    const pmap = new Map(prices.map(p => [
      `${String(p.zoneKey||'').toUpperCase()}::${String(p.tariffCode||'').toUpperCase()}`,
      Number(p.priceCents)||0
    ]));
    const lines = items.map(it => {
      const z   = String(it.zoneKey||'').toUpperCase();
      const t   = String(it.tariffCode||'').toUpperCase();
      const sidRaw = String(it.seatId||'').trim();
      // ✅ Ne garder un seatId que s’il correspond à un vrai siège du plan.
      // (IDs virtuels type DEBOUT-Z001 ou libellés "Zone Debout" => seatId vide)
      const realSeat = sidRaw && statusIdx.has(sidRaw);
      const sid = realSeat ? sidRaw : '';
      const key = `${z}::${t}`;
    // 🛑 Interdit: tarif absent pour la zone dans la table retenue
      if (!pmap.has(key)) {
        throw new Error(`Tarif indisponible pour la zone (${z}/${t})${scope==='fallback'?' [fallback]':''}`);
      }
      return {
        // ⚠️ garder seatId tel quel (DEBOUT-Z001, N5-J-057, ...)
        seatId:       sid,
        zoneKey:      String(it.zoneKey||'').toUpperCase(),
        // normaliser les noms attendus par les e-mails/outils
        tariffCode:   String(it.tariffCode||'').toUpperCase(),
        priceCents:   pmap.get(key),
        // champs optionnels côté front (porteurs)
        holderFirstName: String(it.firstName||''),
        holderLastName:  String(it.lastName||'')
      };
    });
    const totalCents = lines.reduce((s, l) => s + (Number(l.priceCents)||0), 0);
    assert(totalCents > 0, 'Montant total nul (tarifs manquants ?)');

    
    // Crée order "pending" + hold
    const now = new Date();
    const until = new Date(now.getTime() + HOLD_MIN*60*1000);
    const uniqueGroupKey = `EVENT-${ev.slug}-${new mongoose.Types.ObjectId().toString()}`;

    const ord = await Order.create({
      eventId: ev._id,
      itemName:`EVENT_${ev.slug}`,
      phase: 'event',
      paymentProvider: PAYMENT_PROVIDER_ID,
      paymentProviderMeta: {},

      createdAt: now,
      status: 'pending',
      groupKey: uniqueGroupKey,
      payer: {
        firstName: String(payer?.firstName||'').trim(),
        lastName:  String(payer?.lastName||'').trim(),
        email:     String(payer?.email||'').trim()
      },
      // 🧾 lignes normalisées
      lines,
      // 📌 champs “flattened” utilisés par les e-mails & la finalisation
      payerFirstName: String(payer?.firstName||'').trim(),
      payerLastName:  String(payer?.lastName||'').trim(),
      payerEmail:     String(payer?.email||'').trim(),
      totalCents,
      installment: Number(schedule||1),
      paymentSplit: Number(schedule||1),
      // Contexte sièges pour la finalisation
      seasonCode: ev.seasonCode,
      venueSlug:  ev.venueSlug,
      // méta évènement
      schedule: Number(schedule||1),
      meta: {
        eventId:      String(ev._id),
        eventSlug:    ev.slug,
        eventName:    ev.name,       // ⬅️ pour l’objet + template email
        eventStartsAt: ev.startsAt,  // ⬅️ utile si affichage date/heure match
        provider:     PAYMENT_PROVIDER_ID
      },

      origin: { flow: 'event', uiPath: '/event', apiPath: `${req.baseUrl||''}${req.path}` },
      mailTemplateKind: 'event',
      hold: { until }
    });

    // Pose des holds uniquement pour les VRAIS sièges (présents dans statusIdx)
    const holdable = lines.filter(ln => !!ln.seatId && statusIdx.has(ln.seatId));
    // (Les lignes de zone — seatId vide — n’ont pas de hold unitaire : le quota
    //  se gère au niveau des tarifs/zones. La finalisation ignore déjà ces lignes.)
    if (holdable.length) {
      await Promise.all(holdable.map(ln =>
        Seat.updateOne(
          { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, seatId: ln.seatId, status: { $ne: 'booked' } },
          { $set: { status:'busy', 'meta.hold': { orderId: String(ord._id), until } } }
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
    res.json({ ok:true, orderId:String(ord._id), redirectUrl, checkout:intent });
  } catch (e) {
    console.error('[event/checkout] error:', e?.message || e);
    res.status(400).json({ ok:false, error: e.message||'Checkout error' });
  }
});

export default router;
