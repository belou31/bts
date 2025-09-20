// src/routes/admin-event-seats.js
import { Router } from 'express';
import { Order } from '../models/Order.js';
import { Event } from '../models/Event.js';

const router = Router();

/**
 * GET /admin/event/:eventId/seats
 * Liste les places avec bénéficiaire + contact
 */
router.get('/:eventId/seats', async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const ev = await Event.findOne({ $or: [{ _id: eventId }, { slug: eventId }] }).lean();
    if (!ev) return res.status(404).json({ ok: false, error: 'Event not found' });

    // Cherche toutes les commandes payées liées à cet event
    const orders = await Order.find({
      status: 'paid',
      'meta.eventId': String(ev._id)
    }).lean();

    const rows = [];
    for (const o of orders) {
      const contact = {
        firstName: o.payerFirstName || '',
        lastName:  o.payerLastName  || '',
        email:     o.payerEmail     || ''
      };
      for (const l of o.lines || []) {
        const parts = String(l.seatId || '').split('-');
        rows.push({
          section: parts[0] || l.zoneKey || '',
          row:     parts[1] || '',
          seat:    l.seatId || '',
          beneficiaryFirstName: l.holderFirstName || '',
          beneficiaryLastName:  l.holderLastName  || '',
          contactFirstName: contact.firstName,
          contactLastName:  contact.lastName,
          contactEmail:     contact.email
        });
      }
    }

    res.json({ ok: true, event: { id: String(ev._id), name: ev.name }, seats: rows });
  } catch (e) {
    console.error('[admin-event-seats] error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
