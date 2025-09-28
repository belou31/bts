// src/routes/admin.events.js
import { Router } from 'express';
import mongoose from 'mongoose';
import { Event } from '../models/Event.js';
import { Seat } from '../models/Seat.js';
import { Order } from '../models/Order.js';
import { buildTicketsPdfBuffer } from '../services/tickets-pdf.js';
import { sendMail } from '../loaders/mailer.js';

// TODO: remplace par ton vrai middleware d’admin
function requireAdmin(req, _res, next) {
  if (String(process.env.ADMIN_BYPASS || '') === '1') return next();
  // if (!req.user?.isAdmin) return res.status(403).json({ ok:false, error:'forbidden' });
  return next();
}

const router = Router();

/**
 * POST /admin/events/:eventId/send-season-tickets[?dryRun=1]
 * Envoie les billets "match" à tous les abonnés pour un event donné.
 * - Sourcing: Orders d’abonnement (phase:"subscription", status:"paid") avec seatId assigné
 * - Conflit: si le siège est déjà "booked" pour ce match -> on émet un billet "placement à l’arrivée"
 * - Génère 1 PDF par abonné (toutes ses places), envoie par email (ou dryRun)
 */
router.post('/events/:eventId/send-season-tickets', requireAdmin, async (req, res) => {
  try {
    const { eventId } = req.params;
    const dryRun = String(req.query.dryRun || req.body?.dryRun || '0') === '1';

    const ev = await Event.findOne(
      mongoose.isValidObjectId(eventId) ? { _id: eventId } : { slug: String(eventId) }
    ).lean();
    if (!ev) return res.status(404).json({ ok:false, error:'Event not found' });

    // 1) Récupère tous les abonnements payés de la même saison/lieu avec un vrai seatId
    const subs = await Order.find({
      phase: 'subscription',
      status: 'paid',
      seasonCode: ev.seasonCode,
      venueSlug:  ev.venueSlug,
      'lines.seatId': { $exists: true, $ne: '' }
    }).lean();

    if (!subs.length) return res.json({ ok:true, sent:0, dryRun, note:'no subscription orders' });

    // 2) Index des sièges "réservés pour ce match" (déjà vendus) pour détecter un conflit
    const soldForEvent = new Set();
    const eventPaid = await Order.find(
      { 'meta.eventId': String(ev._id), status:'paid' },
      { 'lines.seatId':1, _id:0 }
    ).lean();
    for (const o of eventPaid) {
      for (const ln of (o.lines||[])) {
        const sid = String(ln.seatId||'').trim();
        if (sid) soldForEvent.add(sid);
      }
    }

    // 3) Pour chaque abonné: construire des "tickets virtuels" pour ce match
    //    Conflit => flag specialAccess: true (billet d’accès sans siège)
    let sent = 0, skipped = 0, prepared = 0;
    const tasks = [];

    for (const sub of subs) {
      // Toutes les lignes sièges (un abonné peut avoir plusieurs places)
      const seatLines = (sub.lines || []).filter(l => String(l.seatId||'').trim());
      if (!seatLines.length) { skipped++; continue; }

      // Construit un objet "order-like" minimal pour le générateur PDF
      const tickets = seatLines.map(l => {
        const sid = String(l.seatId).trim();
        const conflict = soldForEvent.has(sid);
        return {
          seatId: sid,
          zoneKey: String(l.zoneKey||'').toUpperCase(),
          // Pour l’affichage PDF: on met le LABEL tarif si dispo, sinon le code
          tariff: String(l.tariffLabel || l.tariff || l.tariffCode || 'NORMAL'),
          hex: Buffer.from(`${sub._id}:${sid}`).toString('base64'),
          specialAccess: conflict // <- billet "accès autorisé, placement à l’arrivée"
        };
      });

      // Order synthétique pour ce match (entrées utilisées par tickets-pdf.js)
      const pseudoOrder = {
        _id: sub._id, // utile dans le pied de page PDF
        payerFirstName: sub.payerFirstName || sub.payer?.firstName || '',
        payerLastName:  sub.payerLastName  || sub.payer?.lastName  || '',
        meta: {
          eventId: String(ev._id),
          eventSlug: ev.slug,
          eventName: ev.name,
          eventStartsAt: ev.startsAt,
          provider: 'internal',
          tickets
        }
      };

      // Génère 1 PDF par abonné (toutes ses places)
      tasks.push((async () => {
        prepared++;
        const pdf = await buildTicketsPdfBuffer(pseudoOrder);
        if (dryRun) return;

        const to = sub.payerEmail || sub.payer?.email;
        if (!to) { skipped++; return; }

        await sendMail({
          to,
          subject: `[Billetterie] Vos billets – ${ev.name}`,
          html: `
            <p>Bonjour ${pseudoOrder.payerFirstName || ''} ${pseudoOrder.payerLastName || ''},</p>
            <p>Veuillez trouver en pièce jointe vos billets pour <strong>${ev.name}</strong> (${new Date(ev.startsAt).toLocaleString('fr-FR')}).</p>
            <p style="color:#555">NB&nbsp;: si l’un de vos sièges était déjà réservé pour ce match, le billet correspondant mentionne <em>accès autorisé – placement à l’arrivée</em>.</p>
            <p>À bientôt à la patinoire&nbsp;!</p>
          `,
          attachments: [{
            filename: `Billets-${ev.slug}-${sub._id}.pdf`,
            contentType: 'application/pdf',
            content: pdf
          }]
        });
        sent++;
      })());
    }

    await Promise.all(tasks);

    return res.json({ ok:true, dryRun, prepared, sent, skipped, event: ev.slug });
  } catch (e) {
    console.error('[admin/send-season-tickets] error:', e);
    return res.status(500).json({ ok:false, error: e.message || 'internal error' });
  }
});

export default router;
