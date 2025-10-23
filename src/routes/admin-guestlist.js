// src/routes/admin-guestlist.js
import { Router } from 'express';
import mongoose, { isValidObjectId } from 'mongoose';
import { Event } from '../models/Event.js';
import { Order } from '../models/Order.js';

const router = Router();

// util: charge par _id OU slug, sans cast foireux
async function loadEventByIdOrSlug(eventIdOrSlug) {
  const s = String(eventIdOrSlug || '').trim();
  if (isValidObjectId(s)) {
    const ev = await Event.findById(new mongoose.Types.ObjectId(s)).lean();
    if (ev) return ev;
  }
  // sinon on tente par slug
  const ev = await Event.findOne({ slug: s }).lean();
  if (!ev) throw new Error('Event not found');
  return ev;
}

// Split "S1-A-001" => {section:"S1", row:"A", seatNo:"001"}
function splitSeat(seatId) {
  const m = /^([A-Z0-9]+)-([A-Z])-(\d{1,4})$/i.exec(String(seatId||'').trim());
  if (!m) return { section: '', row: '', seatNo: '' };
  return { section: m[1].toUpperCase(), row: m[2].toUpperCase(), seatNo: m[3] };
}

router.get('/admin/event/:eventIdOrSlug/guestlist', (req, res) => {
  const key = String(req.params.eventIdOrSlug || '').trim();
  const qs = key ? `?event=${encodeURIComponent(key)}` : '';
  res.redirect(302, `/admin/guestlist${qs}`);
});

router.get('/admin/guestlist', async (req, res) => {
  try {
    const events = await Event.find(
      {},
      { name: 1, slug: 1, startsAt: 1 }
    ).sort({ startsAt: 1 }).lean();

    if (!events.length) {
      res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>Liste des places — Aucun évènement</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 16px; }
  h1 { margin: 0 0 8px; font-size: 18px; }
  p { color: #666; }
</style>
<h1>Liste des places</h1>
<p>Aucun évènement disponible pour le moment.</p>`);
      return;
    }

    let selectedEventKey = String(req.query.event || '').trim();
    if (!selectedEventKey) {
      const first = events[0];
      selectedEventKey = String(first.slug || first._id);
    }

    let ev;
    try {
      ev = await loadEventByIdOrSlug(selectedEventKey);
    } catch (err) {
      const fallback = events[0];
      selectedEventKey = String(fallback.slug || fallback._id);
      ev = await loadEventByIdOrSlug(selectedEventKey);
    }

    const eventOrdersPromise = Order.find(
      { status: 'paid', 'meta.eventId': String(ev._id) },
      { payerFirstName:1, payerLastName:1, payerEmail:1, lines:1 }
    ).lean();

    const seasonOrdersPromise = Order.find(
      {
        status: 'paid',
        phase: 'subscription',
        seasonCode: ev.seasonCode,
        venueSlug: ev.venueSlug
      },
      { payerFirstName:1, payerLastName:1, payerEmail:1, lines:1 }
    ).lean();

    const [eventOrders, seasonOrders] = await Promise.all([eventOrdersPromise, seasonOrdersPromise]);

    const rows = [];
    const seenKeys = new Set();

    const buildKey = (line, contact) => {
      const seatId = String(line.seatId || '').trim();
      if (seatId) return `seat:${seatId.toUpperCase()}`;
      const zone = String(line.zoneKey || '').trim().toUpperCase();
      const holderFirst = String(line.holderFirstName || '').trim().toUpperCase();
      const holderLast = String(line.holderLastName || '').trim().toUpperCase();
      const contactEmail = String(contact.email || '').trim().toLowerCase();
      return `zone:${zone}|holder:${holderFirst}-${holderLast}|contact:${contactEmail}`;
    };

    const appendOrderLines = (orders, source, { skipIfSeen } = {}) => {
      for (const o of orders) {
        const contact = {
          firstName: o.payerFirstName || '',
          lastName:  o.payerLastName  || '',
          email:     o.payerEmail     || '',
        };
        for (const ln of (o.lines || [])) {
          const seatId = String(ln.seatId||'').trim();
          const { section, row, seatNo } = splitSeat(seatId);
          const isRealSeat = !!section && !!row && !!seatNo;
          const key = buildKey(ln, contact);
          if (skipIfSeen && seenKeys.has(key)) continue;
          seenKeys.add(key);

          rows.push({
            section: isRealSeat ? section : (String(ln.zoneKey||'').toUpperCase() || ''),
            row:     isRealSeat ? row     : '',
            seat:    isRealSeat ? seatId  : (ln.zoneKey ? `ZONE ${String(ln.zoneKey).toUpperCase()}` : ''),
            holderFirstName: ln.holderFirstName || '',
            holderLastName:  ln.holderLastName  || '',
            contactFirstName: contact.firstName,
            contactLastName:  contact.lastName,
            contactEmail:     contact.email,
            source
          });
        }
      }
    };

    appendOrderLines(eventOrders, 'Event');
    appendOrderLines(seasonOrders, 'Season', { skipIfSeen: true });

    // Tri: section, rang, numéro
    rows.sort((a,b) => {
      const A = [a.section, a.row, a.seat, a.source || ''].join('|');
      const B = [b.section, b.row, b.seat, b.source || ''].join('|');
      return A.localeCompare(B, 'fr');
    });

    const eventOptionsHtml = events.map(event => {
      const key = String(event.slug || event._id);
      const labelDate = event.startsAt ? new Date(event.startsAt).toLocaleString('fr-FR') : '';
      const attrValue = key
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      return `<option value="${attrValue}"${key === selectedEventKey ? ' selected' : ''}>${event.name} — ${labelDate}</option>`;
    }).join('');

    // Rendu HTML simple
    res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>Liste des places – ${ev.name}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 16px; }
  h1 { margin: 0 0 8px; font-size: 18px; }
  .muted { color: #666; margin-bottom: 12px; }
  form { margin-bottom: 16px; }
  label { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
  select { padding: 6px 10px; font-size: 14px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #eee; text-align: left; white-space: nowrap; }
  th { position: sticky; top: 0; background: #fafafa; border-bottom: 1px solid #ddd; }
  tr:nth-child(even) td { background: #fcfcfc; }
  .right { text-align: right; }
</style>
<h1>Liste des places — ${ev.name}</h1>
<div class="muted">${new Date(ev.startsAt).toLocaleString('fr-FR')}</div>
<form method="get">
  <label>
    Évènement
    <select name="event" onchange="this.form.submit()">
      ${eventOptionsHtml}
    </select>
  </label>
</form>
<table>
  <thead>
    <tr>
      <th>Section</th>
      <th>Rangée</th>
      <th>Siège</th>
      <th>Bénéficiaire · Prénom</th>
      <th>Bénéficiaire · Nom</th>
      <th>Contact · Prénom</th>
      <th>Contact · Nom</th>
      <th>Contact · Email</th>
      <th>Origine</th>
    </tr>
  </thead>
  <tbody>
    ${rows.map(r => `
      <tr>
        <td>${r.section || ''}</td>
        <td>${r.row || ''}</td>
        <td>${r.seat || ''}</td>
        <td>${r.holderFirstName || ''}</td>
        <td>${r.holderLastName || ''}</td>
        <td>${r.contactFirstName || ''}</td>
        <td>${r.contactLastName || ''}</td>
        <td>${r.contactEmail || ''}</td>
        <td>${r.source || ''}</td>
      </tr>`).join('')}
  </tbody>
</table>`);
  } catch (e) {
    res.status(404).type('html').send(`<!doctype html><meta charset="utf-8">
    <h1>Erreur</h1><p>${e.message || 'Not found'}</p>`);
  }
});

export default router;
