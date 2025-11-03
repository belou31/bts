// src/routes/admin/supervision.routes.js
import { Router } from 'express';
import mongoose, { isValidObjectId } from 'mongoose';
import { Event } from '../../models/Event.js';
import { Order } from '../../models/Order.js';
import { Seat }  from '../../models/Seat.js';
import { Zone }  from '../../models/Zone.js';
import { Tariff } from '../../models/Tariff.js';

const router = Router();

// Helpers
const oid = (s) => (isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : null);

// Normalise tickets à partir d'un order (préfère meta.tickets, sinon derive lines)
function extractTicketsFromOrder(ord) {
  const base = Array.isArray(ord?.meta?.tickets) && ord.meta.tickets.length
    ? ord.meta.tickets.map(t => ({
        seatId: t.seatId || '',
        zoneKey: (t.zoneKey || '').toUpperCase(),
        tariffCode: (t.tariff || t.tariffCode || '').toUpperCase(),
        hex: t.hex || '',
        priceCents: t.priceCents ?? null,
        orderId: String(ord._id),
        eventId: ord?.meta?.eventId ? String(ord.meta.eventId) : null,
        createdAt: ord.createdAt,
      }))
    : (ord?.lines || []).map(ln => ({
        seatId: ln.seatId || '',
        zoneKey: (ln.zoneKey || '').toUpperCase(),
        tariffCode: (ln.tariffCode || '').toUpperCase(),
        hex: '', // pas encore généré si pending
        priceCents: ln.priceCents ?? null,
        orderId: String(ord._id),
        eventId: ord?.meta?.eventId ? String(ord.meta.eventId) : null,
        createdAt: ord.createdAt,
      }));
  return base;
}

// GET /admin/supervision/summary
router.get('/summary', async (_req, res) => {
  try {
    const [subs, events, paidSum, pending, seatsBusy] = await Promise.all([
      Order.countDocuments({ phase: 'subscription', status: 'paid' }),
      Event.countDocuments({ isOnSale: true }),
      Order.aggregate([
        { $match: { status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$totalCents' } } }
      ]),
      Order.countDocuments({ status: 'pending' }),
      Seat.countDocuments({ status: 'busy' })
    ]);

    res.json({
      ok: true,
      subscriptionsPaid: subs,
      eventsOnSale: events,
      turnoverCents: paidSum?.[0]?.total || 0,
      pendingOrders: pending,
      seatsBusy
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || 'summary failed' });
  }
});

// GET /admin/supervision/events
// ?onSale=true|false (optional)
router.get('/events', async (req, res) => {
  try {
    const q = {};
    if (typeof req.query.onSale !== 'undefined') {
      q.isOnSale = String(req.query.onSale).toLowerCase() === 'true';
    }
    const list = await Event.find(q).sort({ startsAt: 1 }).lean();

    // enrichit avec métriques rapides
    const ids = list.map(e => e._id);
    const counts = await Order.aggregate([
      { $match: { 'meta.eventId': { $in: ids.map(String) } } },
      { $group: { _id: '$meta.eventId', paid: { $sum: { $cond:[{$eq:['$status','paid']},1,0]} },
                  pending: { $sum: { $cond:[{$eq:['$status','pending']},1,0]} },
                  totalCents: { $sum: { $cond:[{$eq:['$status','paid']}, '$totalCents', 0] } } } }
    ]);

    const byId = new Map(counts.map(c => [String(c._id), c]));
    const out = list.map(e => {
      const c = byId.get(String(e._id)) || {};
      return {
        id: String(e._id),
        slug: e.slug,
        name: e.name,
        startsAt: e.startsAt,
        isOnSale: e.isOnSale,
        venueSlug: e.venueSlug,
        paidOrders: c.paid || 0,
        pendingOrders: c.pending || 0,
        turnoverCents: c.totalCents || 0
      };
    });
    res.json({ ok:true, events: out });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || 'events failed' });
  }
});

// GET /admin/supervision/orders
// ?eventId=...&status=paid|pending&phase=event|subscription&limit=50
router.get('/orders', async (req, res) => {
  try {
    const q = {};
    if (req.query.eventId) q['meta.eventId'] = String(req.query.eventId);
    if (req.query.status) q.status = String(req.query.status);
    if (req.query.phase) q.phase = String(req.query.phase);
    const limit = Math.min(500, Number(req.query.limit || 100));

    const orders = await Order.find(q)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ ok:true, count: orders.length, orders });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || 'orders failed' });
  }
});

// GET /admin/supervision/tickets
// ?eventId=...&status=paid|pending&withQr=true
router.get('/tickets', async (req, res) => {
  try {
    const q = {};
    if (req.query.eventId) q['meta.eventId'] = String(req.query.eventId);
    if (req.query.status) q.status = String(req.query.status);

    const withQr = String(req.query.withQr || 'false').toLowerCase() === 'true';

    const orders = await Order.find(q)
      .select('status lines meta.tickets meta.eventId meta.eventName meta.eventStartsAt payerEmail createdAt')
      .sort({ createdAt: -1 })
      .lean();

    // option: enrichir avec labels de tarifs (facultatif)
    let tLabel = {};
    if (req.query.eventId) {
      const ev = await Event.findById(req.query.eventId).lean();
      if (ev?.priceTableKey) {
        const tariffs = await Tariff.find({ priceTableKey: ev.priceTableKey, active: true }).lean();
        tLabel = Object.fromEntries(
          tariffs.map(t => [String(t.code || t.tariffCode || '').toUpperCase(), t.label || t.name || t.code])
        );
      }
    }

    const flat = [];
    for (const o of orders) {
      const ts = extractTicketsFromOrder(o);
      for (const t of ts) {
        if (withQr && !t.hex) continue; // ne garder que les tickets finalisés
        flat.push({
          orderId: String(o._id),
          status: o.status,
          eventId: t.eventId || (o.meta?.eventId ? String(o.meta.eventId) : null),
          eventName: o.meta?.eventName || null,
          eventStartsAt: o.meta?.eventStartsAt || null,
          seatId: t.seatId,
          zoneKey: t.zoneKey,
          tariffCode: t.tariffCode,
          tariffLabel: tLabel[t.tariffCode] || t.tariffCode,
          priceCents: t.priceCents,
          hasQr: !!t.hex,
          createdAt: o.createdAt,
          buyerEmail: o.payerEmail || null,
        });
      }
    }

    res.json({ ok:true, count: flat.length, tickets: flat });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || 'tickets failed' });
  }
});

export default router;
