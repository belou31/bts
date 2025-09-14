import { Seat } from '../models/Seat.js';
import { renderOrderEmail, subjectForOrder } from './mailer.js';
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

export function realSeatIdsFromOrder(order) {
  return Array.from(new Set(
    (order?.lines || [])
      .map(l => String(l.seatId || '').trim())
      .filter(s => s && !isVirtualZoneSeatId(s))
  ));
}

// Finalisation atomique anti-doublon. Ne fait PAS d’email.
export async function finalizePaidIfNoConflict(order) {
  const seatIds = realSeatIdsFromOrder(order);
  if (!seatIds.length) {
    order.status = 'paid';
    await order.save();
    return { ok: true, booked: 0, conflicts: [] };
  }

  const seats = await Seat.find({
    seasonCode: order.seasonCode,
    venueSlug:  order.venueSlug,
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

  const upd = await Seat.updateMany(
    {
      seasonCode: order.seasonCode,
      venueSlug:  order.venueSlug,
      seatId:     { $in: seatIds },
      $or: [
        { status: 'available' },
        { status: 'busy', 'meta.hold.orderId': order._id }
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

export async function sendOrderAttestationIfNeeded(order) {
  if (order?.paymentProviderMeta?.attestationSentAt) return false;
  const html = await renderOrderEmail(order);
  const subject = subjectForOrder(order);
  await sendMail({ to: order.payerEmail, subject, html });
  order.paymentProviderMeta = { ...(order.paymentProviderMeta || {}), attestationSentAt: new Date() };
  await order.save();
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
