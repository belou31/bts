//src/services/order-finalization.js
import mongoose from 'mongoose';
import { Seat } from '../models/Seat.js';
import { Order } from '../models/Order.js';
import { Event } from '../models/Event.js';
import { SeatHold } from '../models/SeatHold.js';
import { Ticket } from '../models/Ticket.js';
import { computeEventSeatStates } from './event-seat-states.js';
import { renderOrderEmail, subjectForOrder, attachQrFromBank } from './mailer.js';
import { buildTicketsPdfBuffer } from './tickets-pdf.js';
import { sendMail } from '../loaders/mailer.js';
import { normalizeStatus as providerNormalizeStatus } from './payments/index.js';
import { resolveLinePlacement } from '../utils/event-attendance.js';
import { resolveUnitType, zoneKeyFromSeatId } from '../utils/seat-id.js';
import { t } from '../utils/i18n.js';

export function normalizePaymentStatus(input, fallback) {
  return providerNormalizeStatus(input, fallback);
}

export const normalizeHaStatus = normalizePaymentStatus;

export const isPaidLike = (s) =>
  /^(paid|processed|authorized|authorized_ok|ok|success|succeeded)$/i.test(String(s||''));

export const isRefundedLike = (s) =>
  /^(refunded|refund|reimbursed|reversed|chargeback|payment_refunded)$/i.test(String(s||''));

export function realSeatIdsFromOrder(order) {
  const seats = [];
  for (const line of (order?.lines || [])) {
    const placement = resolveLinePlacement(line);
    if (placement.released) continue;
    const seatId = String(placement.seatId || '').trim();
    if (!seatId) continue;
    // A "moved" attendance override reassigns the physical seat after the
    // fact, so its resolved seatId is the newer truth — classify it by
    // shape rather than trusting the line's original (now stale) unitType.
    const unitType = placement.moved ? undefined : line?.unitType;
    if (resolveUnitType({ unitType, seatId }) !== 'seat') continue;
    seats.push(seatId);
  }
  return Array.from(new Set(seats));
}


export function generateTicketHex(orderId, index, seatId, zoneKey, tariffCode) {
  const seat = seatId ? `S:${seatId}` : `Z:${zoneKey || 'ZONE'}`;
  const tariff = tariffCode ? `T:${tariffCode}` : 'T:NORMAL';
  const payload = `E:${orderId}:${seat}:${tariff}:${index}`;
  return Buffer.from(payload, 'utf8').toString('base64').replace(/=+$/,'');
}

async function hydrateTicketsFromExistingDocs(order) {
  const orderId = order?._id;
  if (!orderId) return false;
  const metaTickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  const hasQr = metaTickets.some((t) => {
    const hex = String(t?.hex || t?.value || '').trim();
    return !!hex;
  });
  if (hasQr) return false;

  const docs = await Ticket.find({ orderId }).sort({ createdAt: 1 }).lean();
  if (!docs.length) return false;

  const hydrated = docs
    .map((doc) => {
      const qrValue = String(doc?.qr?.value || '').trim();
      if (!qrValue) return null;
      const tariff = String(doc?.tariffCode || '').toUpperCase() || 'NORMAL';
      return {
        ticketId: String(doc._id),
        seatId: doc.seatId || '',
        zoneKey: zoneKeyFromSeatId(doc.seatId),
        tariff,
        tariffCode: tariff,
        hex: qrValue,
        value: qrValue,
        createdAt: doc?.qr?.createdAt || doc.createdAt || new Date()
      };
    })
    .filter(Boolean);

  if (!hydrated.length) return false;

  order.meta = { ...(order.meta || {}), tickets: hydrated };
  if (typeof order.markModified === 'function') {
    order.markModified('meta.tickets');
  }
  await order.save();
  return true;
}


// Le siège effectif d'une ligne pour CET évènement. Un changement de place
// (utils/event-attendance.js) est stocké en override et laisse line.seatId
// intact : sans cette résolution, la normalisation ci-dessous réécrirait le
// billet vers l'ancienne place, et le doc Ticket suivrait — le porteur
// recevrait un PDF et un contrôle d'accès pointant le mauvais siège.
// Volontairement limité au cas 'moved' : une ligne 'released' garde le
// comportement historique.
function effectiveLineSeatId(line) {
  const placement = resolveLinePlacement(line);
  return placement.moved && placement.seatId
    ? String(placement.seatId).trim()
    : String(line?.seatId || '').trim();
}

export async function ensureTicketsForEventOrder(order) {
  const eventIdRaw = order?.eventId || order?.meta?.eventId;
  if (!eventIdRaw) return { created: 0, updated: 0 };

  const lines = Array.isArray(order?.lines) ? order.lines : [];
  let metaTickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  const orderId = order._id;
  const now = new Date();
  let created = 0;
  let updated = 0;
  let metaChanged = false;

  if (!metaTickets.length && orderId) {
    const existingDocs = await Ticket.find({ orderId }).sort({ createdAt: 1 }).lean();
    if (existingDocs.length) {
      order.meta = order.meta || {};
      order.meta.tickets = existingDocs
        .map(doc => {
          const qrValue = String(doc?.qr?.value || '').trim();
          if (!qrValue) return null;
          const tariff = String(doc?.tariffCode || '').toUpperCase() || 'NORMAL';
          return {
            ticketId: String(doc._id),
            seatId: doc.seatId || '',
            zoneKey: zoneKeyFromSeatId(doc.seatId),
            tariff,
            tariffCode: tariff,
            hex: qrValue,
            value: qrValue,
            createdAt: doc?.qr?.createdAt || doc.createdAt || now
          };
        })
        .filter(Boolean);
      metaTickets = order.meta.tickets;
      if (metaTickets.length) {
        metaChanged = true;
      }
    }
  }

  const qrBankModeEnabled = String(process.env.QR_BANK_MODE || '').toLowerCase() === 'true';
  if (!metaTickets.length && lines.length) {
    order.meta = order.meta || {};
    order.meta.tickets = lines.map((line, index) => {
      const seatId = effectiveLineSeatId(line);
      const zoneKey = String(line?.zoneKey || '').trim().toUpperCase();
      const tariffCode = String(line?.tariffCode || line?.tariff || 'NORMAL').toUpperCase();
      const hex = generateTicketHex(orderId, index, seatId, zoneKey, tariffCode);
      return {
        seatId,
        zoneKey,
        tariff: tariffCode,
        tariffCode,
        hex,
        value: hex,
        createdAt: now,
      };
    });
    metaTickets = order.meta.tickets;
    metaChanged = true;
  }

  if (!metaTickets.length) return { created: 0, updated: 0 };

  // Normalise tickets so they align 1:1 with lines and provide unique QR codes
  const metaPool = [...metaTickets];
  const normalisedMeta = [];
  const usedHex = new Set();

  const takeTicket = (predicate) => {
    const idx = metaPool.findIndex(predicate);
    if (idx === -1) return null;
    return metaPool.splice(idx, 1)[0];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || {};
    const seatFromLine = effectiveLineSeatId(line);
    const zoneFromLine = String(line.zoneKey || '').trim().toUpperCase();
    const tariffFromLine = String(line.tariffCode || '').trim().toUpperCase() || 'NORMAL';

    let ticket = null;
    if (seatFromLine) {
      ticket = takeTicket(t => String(t?.seatId || '').trim() === seatFromLine);
    }
    if (!ticket && zoneFromLine) {
      ticket = takeTicket(t =>
        !t?.seatId &&
        String(t?.zoneKey || '').toUpperCase() === zoneFromLine &&
        String(t?.tariff || t?.tariffCode || '').toUpperCase() === tariffFromLine
      );
    }
    if (!ticket) {
      ticket = metaPool.length ? metaPool.shift() : {};
    }

    if (seatFromLine && String(ticket.seatId || '') !== seatFromLine) {
      ticket.seatId = seatFromLine;
      metaChanged = true;
    }
    if (zoneFromLine && String(ticket.zoneKey || '').toUpperCase() !== zoneFromLine) {
      ticket.zoneKey = zoneFromLine;
      metaChanged = true;
    }
    const currentTariff = String(ticket.tariff || ticket.tariffCode || '').toUpperCase();
    if (currentTariff !== tariffFromLine) {
      ticket.tariff = tariffFromLine;
      ticket.tariffCode = tariffFromLine;
      metaChanged = true;
    }

    let hex = String(ticket.hex || ticket.value || '').trim();
    if (!hex || usedHex.has(hex)) {
      hex = generateTicketHex(orderId, i, seatFromLine, zoneFromLine, tariffFromLine);
      ticket.hex = hex;
      ticket.value = hex;
      metaChanged = true;
    }
    usedHex.add(hex);

    normalisedMeta.push(ticket);
  }

  if (metaPool.length) metaChanged = true; // leftovers not matched to lines

  // Replace meta tickets with the normalised list for downstream processing
  order.meta = order.meta || {};
  const originalLength = metaTickets.length;
  metaTickets.splice(0, metaTickets.length, ...normalisedMeta);
  if (originalLength !== normalisedMeta.length) metaChanged = true;

  for (let i = 0; i < metaTickets.length; i++) {
    const metaTicket = metaTickets[i] || {};
    const line = lines[i] || {};

    const qrValue = String(metaTicket.hex || metaTicket.value || '').trim();
    if (!qrValue) continue;

    const zoneKey = String(metaTicket.zoneKey || line.zoneKey || '').toUpperCase();
    const seatFromMeta = String(metaTicket.seatId || '').trim();
    const seatFromLine = effectiveLineSeatId(line);
    let seatId = seatFromMeta || seatFromLine;
    let usedPlaceholder = false;
    // Computed from the pre-placeholder candidate so re-runs (e.g. resend)
    // still classify correctly even once seatId already holds a synthesized
    // GA-style id from a previous pass.
    const unitType = resolveUnitType({ unitType: line.unitType, seatId });

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
          unitType,
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
      if (ticketDoc.unitType !== unitType) {
        ticketDoc.unitType = unitType;
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
  const eventIdRaw = order?.eventId || order?.meta?.eventId;
  const isEvent = !!eventIdRaw;   // ⬅️ nouvel indicateur
  const meta = { ...(order.paymentProviderMeta || {}) };
  const now = new Date();
  const currentStatus = String(order?.status || '').toLowerCase();

  if (currentStatus === 'canceled' || currentStatus === 'refunded') {
    meta.lastFinalizeResult = `blocked_${currentStatus}`;
    meta.lastFinalizeAttemptAt = now;
    order.paymentProviderMeta = meta;
    await order.save();
    return {
      ok: false,
      blocked: true,
      booked: 0,
      conflicts: [{ reason: `order_${currentStatus}` }]
    };
  }

  meta.finalizeAttemptCount = Number(meta.finalizeAttemptCount || 0) + 1;
  meta.lastFinalizeAttemptAt = now;

  if (order.status === 'paid') {
    meta.lastFinalizeResult = 'already_paid';
    order.paymentProviderMeta = meta;
    await order.save();
    return { ok: true, booked: 0, conflicts: [], alreadyFinalized: true };
  }

  if (!seatIds.length) {
    order.status = 'paid';
    {
      const failed = await commitPaidOrder(order, meta, now);
      if (failed) return failed;
    }
    // Une commande payée SANS siège, c'est l'achat d'un bon : c'est ici, au
    // moment exact où le paiement est acquis, que le bon doit naître. Le faire
    // plus tôt offrirait des places non payées ; plus tard demanderait un
    // second point de passage. issueVoucherForPurchase est idempotent, la
    // finalisation pouvant être rejouée (retour, webhook, relance).
    if (String(order?.origin?.flow || '').toLowerCase() === 'voucher-purchase') {
      try {
        const { issueVoucherForPurchase } = await import('./vouchers.js');
        await issueVoucherForPurchase(order);
      } catch (err) {
        console.error('[finalize] voucher issue failed:', err?.message || err);
      }
    }
    return { ok: true, booked: 0, conflicts: [] };
  }

  const seats = await Seat.find({
    seasonCode: String(order.seasonCode||''),
    venueSlug:  String(order.venueSlug||''),
    seatId:     { $in: seatIds }
  }).lean();
  const byId = new Map(seats.map(s => [String(s.seatId), s]));

  const ownHold = (sid) => {
    const holder = byId.get(sid)?.meta?.hold?.orderId;
    return holder ? String(holder) === String(order._id) : false;
  };

  const conflicts = [];
  if (isEvent) {
    // Pour un ÉVÈNEMENT, la disponibilité n'est pas Seat.status : cette
    // collection décrit la SAISON. Une place rendue par un abonné pour ce match
    // précis y reste 'booked' — il la garde pour tous les autres matchs — donc
    // juger le conflit sur l'état saison refusait la finalisation d'un achat
    // pourtant légitime : paiement encaissé, commande en échec, "intervention
    // manuelle". On interroge donc la même vue évènement que la billetterie.
    const ev = await Event.findById(eventIdRaw).lean().catch(() => null);
    const states = ev ? await computeEventSeatStates(ev) : [];
    const stateById = new Map(states.map(s => [String(s.seatId), s]));
    // Les SeatHold posés par CETTE commande ne peuvent pas lui être opposés.
    const heldByThisOrder = new Set(
      (await SeatHold.find({ orderId: order._id }, { seatId: 1, _id: 0 }).lean().catch(() => []))
        .map(h => String(h.seatId))
    );

    for (const sid of seatIds) {
      const st = stateById.get(sid);
      if (!st) { conflicts.push({ seatId: sid, reason: 'not_found' }); continue; }
      if (st.status === 'available') continue;
      if (ownHold(sid) || heldByThisOrder.has(sid)) continue;
      conflicts.push({ seatId: sid, reason: st.status === 'booked' ? 'already_booked' : 'busy_other' });
    }
  } else {
    for (const sid of seatIds) {
      const s = byId.get(sid);
      if (!s) { conflicts.push({ seatId: sid, reason: 'not_found' }); continue; }
      if (s.status === 'booked') { conflicts.push({ seatId: sid, reason: 'already_booked' }); continue; }
      if (s.status === 'busy' && !ownHold(sid)) {
        conflicts.push({ seatId: sid, reason: 'busy_other' });
        continue;
      }
    }
  }
  if (conflicts.length) {
    order.status = 'failed';
    meta.lastFinalizeResult = 'conflict';
    meta.lastFinalizeConflictAt = now;
    meta.conflict = { source: 'finalize', kind: 'seat_conflict', seats: conflicts, checkedAt: now };
    order.paymentProviderMeta = meta;
    await order.save();
    return { ok: false, booked: 0, conflicts };
  }

  // État des sièges AVANT toute écriture, pour pouvoir revenir en arrière si
  // l'enregistrement de la commande échoue ensuite. Un 'provisioned' rendu
  // 'available' priverait un renouveleur de sa place : on restaure à
  // l'identique, pas à une valeur par défaut.
  const priorSeatStates = new Map(
    (seats || []).map(r => [String(r.seatId), { status: r.status, provisionedFor: r.provisionedFor ?? null }])
  );

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

    // Idem pour le verrou évènement : la commande est payée, c'est elle qui
    // occupe désormais la place via l'overlay. Le laisser expirer tout seul
    // (TTL) bloquerait inutilement une éventuelle correction entre-temps.
    await SeatHold.deleteMany({ orderId: order._id }).catch(() => {});

    // L’état “booked” pour le plan du match sera géré en LECTURE
    // par /api/event/:id/status (overlay à partir des Orders paid).
    order.status = 'paid';
    meta.lastFinalizeResult = 'success';
    meta.lastSuccessfulFinalizeAt = now;
    if (seatIds.length) meta.finalizedSeatIds = seatIds;
    if (meta.conflict) delete meta.conflict;
    order.paymentProviderMeta = meta;
    {
      const failed = await commitPaidOrder(order, meta, now);
      if (failed) return failed;
    }
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
        // renouvellement : le siège a été réservé par renewal-provision-seats.js
        // en amont de la campagne, avant même que cette commande existe — c'est
        // l'état de départ NORMAL pour un paiement de renouvellement, pas un conflit.
        { status: 'provisioned' },
        // busy tenu par cet ordre en ObjectId...
        { status: 'busy', 'meta.hold.orderId': order._id },
       // ...ou en String (cas /event et historiques)
        { status: 'busy', 'meta.hold.orderId': String(order._id) }
      ]
    },

    { $set: { status: 'booked' }, $unset: { 'meta.hold': 1, provisionedFor: 1 } },
      { runValidators: false }
    );
    const modified = Number(upd.modifiedCount ?? upd.nModified ?? 0);
    if (modified !== seatIds.length) {
      order.status = 'failed';
      meta.lastFinalizeResult = 'conflict';
      meta.lastFinalizeConflictAt = now;
      meta.conflict = { source: 'finalize', kind: 'seat_conflict_race', modified, expected: seatIds.length, checkedAt: now };
      order.paymentProviderMeta = meta;
      await order.save();
      return { ok: false, booked: modified, conflicts: [{ reason: 'race_condition', modified, expected: seatIds.length }] };
    }
    order.status = 'paid';
    meta.lastFinalizeResult = 'success';
    meta.lastSuccessfulFinalizeAt = now;
    if (seatIds.length) meta.finalizedSeatIds = seatIds;
    if (meta.conflict) delete meta.conflict;
    order.paymentProviderMeta = meta;

    // Les sièges viennent d'être passés à 'booked' ; si l'enregistrement de la
    // commande échoue APRÈS, on laisse des places réservées au nom d'une
    // commande qui n'est pas payée — l'état le plus difficile à rattraper.
    // Le cas réel : l'index uniq_paid_per_payer refuse une SECONDE commande
    // payée pour le même (saison, lieu, groupKey, payeur).
    {
      const failed = await commitPaidOrder(order, meta, now, {
        onFailure: () => restoreSeatStates(order, priorSeatStates)
      });
      if (failed) return failed;
    }
    return { ok: true, booked: modified, conflicts: [] };
  }  
}

/**
 * Enregistre le passage à 'paid', en traitant l'échec comme un cas prévu.
 *
 * L'index uniq_paid_per_payer refuse une SECONDE commande payée pour le même
 * (saison, lieu, groupKey, payeur). Comme groupKey vaut « SUBSCRIPTION-<saison> »
 * ou « RENEW-<saison> » pour tout le monde, cela revient à : un seul paiement
 * abouti par personne et par saison. Le rejet arrive APRÈS l'écriture des
 * sièges — d'où le repli fourni par l'appelant.
 *
 * @returns {null|object} null si tout va bien, sinon le résultat d'échec.
 */
async function commitPaidOrder(order, meta, now, { onFailure } = {}) {
  try {
    await order.save();
    return null;
  } catch (err) {
    if (typeof onFailure === 'function') await onFailure();
    const duplicate = err?.code === 11000;
    order.status = 'failed';
    meta.lastFinalizeResult = duplicate ? 'duplicate_paid_order' : 'save_failed';
    meta.lastFinalizeConflictAt = now;
    meta.conflict = {
      source: 'finalize',
      kind: duplicate ? 'duplicate_paid_order' : 'save_failed',
      detail: err?.message || String(err),
      checkedAt: now
    };
    order.paymentProviderMeta = meta;
    await order.save().catch(() => { /* l'état d'échec est au mieux de nos moyens */ });
    return {
      ok: false,
      booked: 0,
      duplicate,
      conflicts: [{ reason: duplicate ? 'duplicate_paid_order' : 'save_failed', detail: err?.message || String(err) }]
    };
  }
}

/** Remet les sièges dans l'état exact où ils étaient avant la finalisation. */
async function restoreSeatStates(order, priorStates) {
  for (const [seatId, prior] of priorStates) {
    const set = { status: prior.status };
    const update = prior.provisionedFor
      ? { $set: { ...set, provisionedFor: prior.provisionedFor } }
      : { $set: set };
    await Seat.updateOne(
      { seasonCode: order.seasonCode, venueSlug: order.venueSlug, seatId },
      update,
      { runValidators: false }
    ).catch(() => { /* la restauration ne doit jamais masquer l'erreur d'origine */ });
  }
}

export async function sendOrderAttestationIfNeeded(order, options = {}) {
  if (!order?._id) {
    throw new Error('sendOrderAttestationIfNeeded requires an order with _id');
  }

  const { force = false, source = 'auto', refreshQr = false } = options;
  const now = new Date();
  const meta = { ...(order.paymentProviderMeta || {}) };
  const alreadySentAt = meta.attestationSentAt ? new Date(meta.attestationSentAt) : null;

  if (!force && alreadySentAt) {
    return false;
  }

  const lockTtlRaw = Number(process.env.ATTESTATION_SEND_LOCK_MS);
  const lockTtlMs = Number.isFinite(lockTtlRaw) && lockTtlRaw > 0 ? lockTtlRaw : 10 * 60 * 1000;
  const staleCutoff = new Date(now.getTime() - lockTtlMs);
  const lockUpdate = {
    $set: {
      'paymentProviderMeta.attestationSendingAt': now,
      'paymentProviderMeta.attestationSendingSource': source
    }
  };
  let lockAcquired = false;

  try {
    if (force) {
      await Order.updateOne({ _id: order._id }, lockUpdate);
      lockAcquired = true;
    } else {
      const lockFilter = {
        _id: order._id,
        $and: [
          {
            $or: [
              { 'paymentProviderMeta.attestationSentAt': { $exists: false } },
              { 'paymentProviderMeta.attestationSentAt': null }
            ]
          },
          {
            $or: [
              { 'paymentProviderMeta.attestationSendingAt': { $exists: false } },
              { 'paymentProviderMeta.attestationSendingAt': null },
              { 'paymentProviderMeta.attestationSendingAt': { $lte: staleCutoff } }
            ]
          }
        ]
      };
      const res = await Order.updateOne(lockFilter, lockUpdate);
      if (!res.modifiedCount) {
        return false;
      }
      lockAcquired = true;
    }

    const sendingMeta = {
      ...meta,
      attestationSendingAt: now,
      attestationSendingSource: source
    };
    order.paymentProviderMeta = sendingMeta;
    order.markModified('paymentProviderMeta');

    const isEvent = !!(order?.eventId || order?.meta?.eventId);

    // 1) Assure qu'on réutilise d'anciens billets si disponibles
    let tickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
    let hasExistingQr = tickets.some((t) => {
      const hex = String(t?.hex || t?.value || '').trim();
      return !!hex;
    });
    if (!hasExistingQr) {
      const hydrated = await hydrateTicketsFromExistingDocs(order);
      if (hydrated) {
        tickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
        hasExistingQr = tickets.some((t) => {
          const hex = String(t?.hex || t?.value || '').trim();
          return !!hex;
        });
      }
    }

    // 2) Banque de QR → order.meta.tickets (uniquement si aucune QR existante ou refresh forcé)
    const shouldAttachQrFromBank = refreshQr || (!hasExistingQr && Array.isArray(order?.lines) && order.lines.length > 0);
    if (shouldAttachQrFromBank) {
      try {
        const r = await attachQrFromBank(mongoose.connection.db, order);
        if (r?.ok && Array.isArray(r.tickets) && r.tickets.length) {
          order.meta = { ...(order.meta || {}), tickets: r.tickets };
          await order.save();
        }
      } catch (e) {
        console.warn('[mail] attachQrFromBank failed:', e.message);
      }
    }

    try {
      await ensureTicketsForEventOrder(order);
    } catch (e) {
      console.warn('[mail] ensureTicketsForEventOrder failed:', e.message);
    }

    // Sujet + HTML après avoir garanti les tickets/QR
    const subject = await subjectForOrder(order);
    const html = await renderOrderEmail(order);

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

    const sentAt = new Date();
    const finalMeta = {
      ...order.paymentProviderMeta,
      attestationSentAt: sentAt
    };
    delete finalMeta.attestationSendingAt;
    delete finalMeta.attestationSendingSource;
    order.paymentProviderMeta = finalMeta;
    order.markModified('paymentProviderMeta');

    try {
      await order.save();
    } catch (err) {
      console.warn('[mail] order save after attestation failed:', err?.message || err);
    }

    return true;
  } finally {
    if (lockAcquired) {
      const update = {
        $unset: {
          'paymentProviderMeta.attestationSendingAt': 1,
          'paymentProviderMeta.attestationSendingSource': 1
        }
      };
      const sentAtFinal = order.paymentProviderMeta?.attestationSentAt;
      if (sentAtFinal) {
        update.$set = { 'paymentProviderMeta.attestationSentAt': sentAtFinal };
      }
      try {
        await Order.updateOne(
          { _id: order._id },
          update
        );
      } catch (e) {
        console.warn('[mail] unlock attestation failed:', e?.message || e);
      }
      if (sentAtFinal) {
        order.paymentProviderMeta = {
          ...(order.paymentProviderMeta || {}),
          attestationSentAt: sentAtFinal
        };
      } else if (alreadySentAt) {
        order.paymentProviderMeta = {
          ...(order.paymentProviderMeta || {}),
          attestationSentAt: alreadySentAt
        };
      } else if (order.paymentProviderMeta) {
        delete order.paymentProviderMeta.attestationSentAt;
      }
      if (order.paymentProviderMeta) {
        delete order.paymentProviderMeta.attestationSendingAt;
        delete order.paymentProviderMeta.attestationSendingSource;
      }
    }
  }
}

/**
 * Le paiement est passé mais le siège n'a pas pu être verrouillé (quelqu'un
 * d'autre l'a pris entre-temps).
 *
 * Ce cas n'envoyait RIEN sur le retour de paiement : l'abonné voyait
 * l'avertissement « intervention manuelle » à l'écran, puis plus rien — aucune
 * trace dans sa boîte mail de ce qu'il venait de payer. sendConflictEmail() ne
 * convenait pas ici : il annonce un remboursement, alors qu'ici l'argent est
 * bien encaissé et la commande honorée, seul le placement reste à faire.
 *
 * On renvoie donc le récapitulatif de commande, précédé de l'avertissement, et
 * suivi du lien de changement de place quand il y en a un.
 */
export async function sendSeatPendingNotice(order, options = {}) {
  const to = order?.payerEmail;
  if (!to) {
    console.warn('[finalize] seat-pending notice skipped: no payerEmail on order', String(order?._id || ''));
    return false;
  }
  const { seatChangeUrl = '', source = 'auto' } = options;
  const locale = order?.locale;

  // Le récapitulatif reprend le rendu normal ; s'il échoue, on préfère un
  // message court à pas de message du tout.
  let recapHtml = '';
  try {
    recapHtml = await renderOrderEmail(order);
  } catch (e) {
    console.warn('[finalize] seat-pending recap render failed:', e?.message || e);
  }

  const relocate = seatChangeUrl
    ? `<p style="margin:.75rem 0">${t('email.seatPendingRelocate', locale)}
         <a href="${seatChangeUrl}">${t('email.seatPendingRelocateLink', locale)}</a></p>`
    : `<p style="margin:.75rem 0">${t('email.seatPendingNoAction', locale)}</p>`;

  const notice = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
    <p>${t('email.greeting', locale)} ${[order?.payerFirstName, order?.payerLastName].filter(Boolean).join(' ') || ''},</p>
    <div style="border-left:4px solid #b45309;background:#fef3c7;padding:.75rem 1rem;margin:1rem 0">
      <p style="margin:0 0 .5rem"><strong>${t('email.seatPendingIntro', locale)}</strong></p>
      ${relocate}
    </div>
    <p>${t('email.conflictOrderRef', locale)} : <strong>${order._id}</strong></p>
  </div>`;

  const html = recapHtml
    ? `${notice}<hr style="margin:1.5rem 0;border:none;border-top:1px solid #ddd">
       <h3 style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">${t('email.seatPendingRecap', locale)}</h3>
       ${recapHtml}`
    : notice;

  try {
    await sendMail({ to, subject: t('email.seatPendingSubject', locale), html });
  } catch (e) {
    console.warn('[finalize] seat-pending mail failed:', e?.message || e);
    return false;
  }

  // Trace d'envoi : sans elle, chaque rechargement de la page de retour
  // renverrait le même courriel.
  try {
    await Order.updateOne(
      { _id: order._id },
      { $set: { 'paymentProviderMeta.seatPendingNoticeSentAt': new Date(),
                'paymentProviderMeta.seatPendingNoticeSource': source } }
    );
  } catch (e) {
    console.warn('[finalize] seat-pending stamp failed:', e?.message || e);
  }
  return true;
}

export async function sendConflictEmail(order) {
  const to = order?.payerEmail;
  if (!to) return;
  const locale = order?.locale;
  const subject = t('email.conflictSubject', locale);
  const html = `<p>${t('email.greeting', locale)} ${[order?.payerFirstName, order?.payerLastName].filter(Boolean).join(' ') || ''},</p>
  <p>${t('email.conflictBody1', locale)}</p>
  <p><strong>${t('email.conflictBody2', locale)}</strong></p>
  <p>${t('email.conflictOrderRef', locale)}&nbsp;: <strong>${order._id}</strong></p>`;
  try { await sendMail({ to, subject, html }); }
  catch (e) { console.warn('[finalize] conflict mail failed:', e.message); }
}
