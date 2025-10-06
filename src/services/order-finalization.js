//src/services/order-finalization.js
import mongoose from 'mongoose';
import { Seat } from '../models/Seat.js';
import { Ticket } from '../models/Ticket.js';
import { renderOrderEmail, subjectForOrder, attachQrFromBank } from './mailer.js';
import { buildTicketsPdfBuffer } from './tickets-pdf.js';
import { sendMail } from '../loaders/mailer.js';

export function normalizeHaStatus(input, fallback) {
  let raw = input;
  if (raw && typeof raw === 'object') {
    raw = raw.status || raw.state || raw.code || raw.result || raw.paymentStatus ||
          (raw.data && (raw.data.status || raw.data.state || raw.data.code)) || '';
  }
  raw = String(raw || fallback || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'payment_succeeded' || raw === 'success' || raw === 'succeeded' || raw === 'ok') return 'succeeded';
  if (raw === 'paid' || raw === 'payment_accepted' || raw === 'processed') return 'paid';
  if (raw.startsWith('authoriz')) return 'authorized';
  return raw;
}

export const isPaidLike = (s) =>
  /^(paid|processed|authorized|authorized_ok|ok|success|succeeded)$/i.test(String(s||''));

const isVirtualZoneSeatId = (sid) => /^.+-Z\d{3,}$/i.test(String(sid||''));
const isRealSeatId        = (sid) => /^[A-Z0-9]+-[A-Z]+-\d{1,4}$/i.test(String(sid||''));


export function realSeatIdsFromOrder(order) {
  return Array.from(new Set(
    (order?.lines || [])
      .map(l => String(l.seatId || '').trim())
      // Ne garder que les vrais seatIds (ZONE-ROW-###) et exclure explicitement les IDs virtuels de zone
      .filter(s => s && isRealSeatId(s) && !isVirtualZoneSeatId(s))
    ));
}


async function ensureTicketsForEventOrder(order) {
  const eventIdRaw = order?.meta?.eventId;
  if (!eventIdRaw) return { created: 0, updated: 0 };

  const metaTickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  if (!metaTickets.length) return { created: 0, updated: 0 };

  const lines = Array.isArray(order?.lines) ? order.lines : [];
  const orderId = order._id;
  const now = new Date();
  let created = 0;
  let updated = 0;
  let metaChanged = false;

  for (let i = 0; i < metaTickets.length; i++) {
    const metaTicket = metaTickets[i] || {};
    const line = lines[i] || {};

    const qrValue = String(metaTicket.hex || metaTicket.value || '').trim();
    if (!qrValue) continue;

    const zoneKey = String(metaTicket.zoneKey || line.zoneKey || '').toUpperCase();
    const seatFromMeta = String(metaTicket.seatId || '').trim();
    const seatFromLine = String(line.seatId || '').trim();
    let seatId = seatFromMeta || seatFromLine;
    let usedPlaceholder = false;

    if (!seatId) {
      const suffix = String(orderId).slice(-6).toUpperCase();
      const index = String(i + 1).padStart(2, '0');
      const zoneLabel = zoneKey || 'ZONE';
      seatId = `${zoneLabel}-GA-${suffix}-${index}`;
      usedPlaceholder = true;
    }

    const holderFirstName = String(line.holderFirstName || '').trim();
    const holderLastName = String(line.holderLastName || '').trim();
    const holderEmail = String(line.holderEmail || order.payerEmail || '').trim();
    const tariffCode = String(line.tariffCode || metaTicket.tariff || metaTicket.tariffCode || '').toUpperCase();

    let ticketDoc = await Ticket.findOne({ orderId, 'qr.value': qrValue });
    if (!ticketDoc) {
      try {
        ticketDoc = await Ticket.create({
          seasonCode: order.seasonCode,
          venueSlug: order.venueSlug,
          eventId: String(eventIdRaw),
          orderId,
          seatId,
          tariffCode,
          holder: {
            firstName: holderFirstName,
            lastName: holderLastName,
            email: holderEmail,
          },
          qr: {
            value: qrValue,
            kind: 'text',
            createdAt: metaTicket.createdAt ? new Date(metaTicket.createdAt) : now,
          },
        });
        created++;
      } catch (err) {
        if (err?.code === 11000) {
          ticketDoc = await Ticket.findOne({ orderId, 'qr.value': qrValue });
          if (!ticketDoc) throw err;
        } else {
          throw err;
        }
      }
    } else {
      let docDirty = false;
      if (ticketDoc.seasonCode !== order.seasonCode) {
        ticketDoc.seasonCode = order.seasonCode;
        docDirty = true;
      }
      if (ticketDoc.venueSlug !== order.venueSlug) {
        ticketDoc.venueSlug = order.venueSlug;
        docDirty = true;
      }
      if (ticketDoc.eventId !== String(eventIdRaw)) {
        ticketDoc.eventId = String(eventIdRaw);
        docDirty = true;
      }
      const seatIdTrimmed = String(ticketDoc.seatId || '').trim();
      if (seatIdTrimmed !== seatId) {
        ticketDoc.seatId = seatId;
        docDirty = true;
      }
      if (String(ticketDoc.tariffCode || '').toUpperCase() !== tariffCode) {
        ticketDoc.tariffCode = tariffCode;
        docDirty = true;
      }
      const holder = ticketDoc.holder || {};
      if ((holder.firstName || '') !== holderFirstName) {
        holder.firstName = holderFirstName;
        docDirty = true;
      }
      if ((holder.lastName || '') !== holderLastName) {
        holder.lastName = holderLastName;
        docDirty = true;
      }
      if ((holder.email || '') !== holderEmail) {
        holder.email = holderEmail;
        docDirty = true;
      }
      if (!ticketDoc.holder) ticketDoc.holder = holder;
      if (!ticketDoc.qr || ticketDoc.qr.value !== qrValue) {
        ticketDoc.qr = {
          value: qrValue,
          kind: 'text',
          createdAt: metaTicket.createdAt ? new Date(metaTicket.createdAt) : (ticketDoc.qr?.createdAt || now),
        };
        docDirty = true;
      } else {
        if (ticketDoc.qr.kind !== 'text') {
          ticketDoc.qr.kind = 'text';
          docDirty = true;
        }
        if (!ticketDoc.qr.createdAt) {
          ticketDoc.qr.createdAt = metaTicket.createdAt ? new Date(metaTicket.createdAt) : now;
          docDirty = true;
        }
      }
      if (docDirty) {
        await ticketDoc.save();
        updated++;
      }
    }

    const ticketIdStr = String(ticketDoc._id);
    if (metaTicket.ticketId !== ticketIdStr) {
      metaTicket.ticketId = ticketIdStr;
      metaChanged = true;
    }
    if (!usedPlaceholder && seatFromMeta !== seatId) {
      metaTicket.seatId = seatId;
      metaChanged = true;
    }
    metaTickets[i] = metaTicket;
  }

  if (metaChanged) {
    order.markModified('meta.tickets');
    await order.save();
  }

  return { created, updated };
}


// Finalisation atomique anti-doublon. Ne fait PAS d’email.
export async function finalizePaidIfNoConflict(order) {
  const seatIds = realSeatIdsFromOrder(order);
  const isEvent = !!order?.meta?.eventId;   // ⬅️ nouvel indicateur

  if (!seatIds.length) {
    order.status = 'paid';
    await order.save();
    return { ok: true, booked: 0, conflicts: [] };
  }

  const seats = await Seat.find({
    seasonCode: String(order.seasonCode||''),
    venueSlug:  String(order.venueSlug||''),
    seatId:     { $in: seatIds }
  }).lean();
  const byId = new Map(seats.map(s => [String(s.seatId), s]));

  const conflicts = [];
  for (const sid of seatIds) {
    const s = byId.get(sid);
    if (!s) { conflicts.push({ seatId: sid, reason: 'not_found' }); continue; }
    if (s.status === 'booked') { conflicts.push({ seatId: sid, reason: 'already_booked' }); continue; }
    if (s.status === 'busy') {
    const holder = s?.meta?.hold?.orderId ? String(s.meta.hold.orderId) : '';
      if (holder && holder !== String(order._id)) {
        conflicts.push({ seatId: sid, reason: 'busy_other' });
        continue;
      }
    }
  }
  if (conflicts.length) {
    order.status = 'failed';
    order.paymentProviderMeta = {
      ...(order.paymentProviderMeta || {}),
      conflict: { source: 'finalize', kind: 'seat_conflict', seats: conflicts, checkedAt: new Date() }
    };
    await order.save();
    return { ok: false, booked: 0, conflicts };
  }

  if (isEvent) {
    // ⚽ Cas ÉVÈNEMENT : ne pas “booker” globalement dans Seat.
    // On libère le hold éventuel porté par CETTE commande (sinon il reste “busy” globalement).
    await Seat.updateMany(
      {
        seasonCode: order.seasonCode,
        venueSlug:  order.venueSlug,
        seatId:     { $in: seatIds },
        'meta.hold.orderId': String(order._id)
      },
      { $set: { status: 'available' }, $unset: { 'meta.hold': 1 } },
      { runValidators: false }
    );

    // L’état “booked” pour le plan du match sera géré en LECTURE
    // par /api/event/:id/status (overlay à partir des Orders paid).
    order.status = 'paid';
    await order.save();
    return { ok: true, booked: seatIds.length, conflicts: [] };
  } else {
    // 🪑 Cas ABONNEMENT : on “booke” définitivement dans Seat (comportement historique)
  const upd = await Seat.updateMany(
    {
      seasonCode: order.seasonCode,
      venueSlug:  order.venueSlug,
      seatId:     { $in: seatIds },
      $or: [
        { status: 'available' },
        // busy tenu par cet ordre en ObjectId...
        { status: 'busy', 'meta.hold.orderId': order._id },
       // ...ou en String (cas /event et historiques)
        { status: 'busy', 'meta.hold.orderId': String(order._id) }
      ]
    },

    { $set: { status: 'booked' }, $unset: { 'meta.hold': 1 } },
      { runValidators: false }
    );
    const modified = Number(upd.modifiedCount ?? upd.nModified ?? 0);
    if (modified !== seatIds.length) {
      order.status = 'failed';
      order.paymentProviderMeta = {
        ...(order.paymentProviderMeta || {}),
        conflict: { source: 'finalize', kind: 'seat_conflict_race', modified, expected: seatIds.length, checkedAt: new Date() }
      };
      await order.save();
      return { ok: false, booked: modified, conflicts: [{ reason: 'race_condition', modified, expected: seatIds.length }] };
    }
    order.status = 'paid';
    await order.save();
    return { ok: true, booked: modified, conflicts: [] };
  }  
}

export async function sendOrderAttestationIfNeeded(order) {

  const isEvent = !!order?.meta?.eventId;

  const tpl = isEvent
    ? (process.env.EMAIL_TEMPLATE_EVENT_CONFIRM || 'event-confirmation')
    : (process.env.EMAIL_TEMPLATE_SUBSCRIPTION_CONFIRM || 'subscription-confirmation');

  const subject = subjectForOrder(order);
  const html = await renderOrderEmail(order);  

   // 1) Banque de QR → order.meta.tickets
   try {
     const r = await attachQrFromBank(mongoose.connection.db, order);
   if (r?.ok && Array.isArray(r.tickets) && r.tickets.length) {
     order.meta = { ...(order.meta || {}), tickets: r.tickets };
      await order.save();
    }
  } catch (e) {
    console.warn('[mail] attachQrFromBank failed:', e.message);
  }

  try {
    await ensureTicketsForEventOrder(order);
  } catch (e) {
    console.warn('[mail] ensureTicketsForEventOrder failed:', e.message);
  }

   // 2) Génère le PDF si tickets présents
   let attachments = [];
   try {
     if (Array.isArray(order?.meta?.tickets) && order.meta.tickets.length) {
       const pdf = await buildTicketsPdfBuffer(order);
console.log('[mail/pdf] bytes=', pdf?.length || 0,
            'tickets=', Array.isArray(order?.meta?.tickets) ? order.meta.tickets.length : 0,
            'kind=', order?.mailTemplateKind);

            attachments.push({
         filename: `billets-${String(order._id)}.pdf`,
         contentType: 'application/pdf',
         content: pdf
       });
     }
   } catch (e) {
     console.warn('[mail] buildTicketsPdfBuffer failed:', e.message);
   }


  await sendMail({ to: order.payerEmail, subject, html, attachments });

  return true;
}

export async function sendConflictEmail(order) {
  const to = order?.payerEmail;
  if (!to) return;
  const subject = 'Votre commande n’a pas pu aboutir';
  const html = `<p>Bonjour ${[order?.payerFirstName, order?.payerLastName].filter(Boolean).join(' ') || ''},</p>
  <p>Votre commande n’a pas pu aboutir&nbsp;: votre paiement a dépassé le temps de blocage de vos sièges et une autre commande s’est insérée.</p>
  <p><strong>Veuillez réessayer.</strong> Si votre paiement est passé, vous serez remboursé.</p>
  <p>Référence commande&nbsp;: <strong>${order._id}</strong></p>`;
  try { await sendMail({ to, subject, html }); }
  catch (e) { console.warn('[finalize] conflict mail failed:', e.message); }
}
