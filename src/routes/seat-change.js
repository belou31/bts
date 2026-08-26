// src/routes/seat-change.js
//
// Self-service seat change for ONE event, offered to season subscribers from
// their ticket email. Deliberately narrow (see docs/operations-runbook.md):
//
//   - same zone only  → the price is identical by construction, so no money
//                       ever moves; there is no refund path in this codebase
//                       (`refunded` is only an inbound webhook status), and a
//                       cross-zone move would need one.
//   - one move per seat → a line already 'moved' is locked.
//   - until kickoff    → the gate list has to settle at some point.
//
// Nothing about the SEASON allocation changes: the move is recorded as a
// per-event override on the order line (utils/event-attendance.js), which the
// event availability overlay already understands. The subscriber keeps the
// same seat for every other match.

import express from 'express';
import jwt from 'jsonwebtoken';

import { Event } from '../models/Event.js';
import { Order } from '../models/Order.js';
import { SeatHold } from '../models/SeatHold.js';
import { Ticket } from '../models/Ticket.js';
import { computeEventSeatStates } from '../services/event-seat-states.js';
import { sendOrderAttestationIfNeeded } from '../services/order-finalization.js';
import { applyAttendancePatch, resolveLinePlacement } from '../utils/event-attendance.js';
import { isVirtualZoneSeatId } from '../utils/seat-id.js';

const router = express.Router();
const TOKEN_KIND = 'seat-change';

// Lu à l'appel et non au chargement : les scripts CLI font `dotenv.config()`
// dans leur corps, donc APRÈS l'évaluation des imports ESM. Figer la valeur
// ici donnerait un secret vide et le lien serait silencieusement omis des
// mails, alors que le serveur (dotenv chargé avant les routes) marcherait.
const jwtSecret = () => process.env.JWT_SECRET;

const norm = (s) => String(s || '').trim();
const upper = (s) => norm(s).toUpperCase();

export function decodeSeatChangeToken(id) {
  const secret = jwtSecret();
  if (!id || !secret) return null;
  try {
    const tok = jwt.verify(id, secret);
    return tok?.kind === TOKEN_KIND ? tok : null;
  } catch {
    return null;
  }
}

/**
 * Signs the link handed to a subscriber. Expires at kickoff, so an expired
 * token and a closed window are the same event rather than two rules that can
 * drift apart.
 */
export function signSeatChangeToken({ eventId, orderId, startsAt }) {
  const secret = jwtSecret();
  if (!secret) throw new Error('JWT_SECRET manquant');
  const exp = Math.floor(new Date(startsAt).getTime() / 1000);
  return jwt.sign(
    { kind: TOKEN_KIND, eventId: String(eventId), orderId: String(orderId), exp },
    secret
  );
}

// A line is eligible while it still sits on a real seat and has never been
// moved. `released` lines are out too: giving a seat up is a different
// decision, handled by admin.
function lineState(line, index) {
  const placement = resolveLinePlacement(line);
  const status = String(line?.attendance?.status || 'kept').toLowerCase();
  const seatId = norm(placement.seatId);
  return {
    index,
    sourceLineId: norm(line?.sourceLineId) || String(index),
    seatId,
    zoneKey: upper(placement.zoneKey || line?.zoneKey),
    holder: [norm(line?.holderFirstName), norm(line?.holderLastName)].filter(Boolean).join(' '),
    alreadyMoved: status === 'moved',
    originalSeatId: norm(line?.seatId),
    changeable: status === 'kept' && !!seatId && !isVirtualZoneSeatId(seatId)
  };
}

async function loadContext(id) {
  const tok = decodeSeatChangeToken(id);
  if (!tok?.eventId || !tok?.orderId) return { error: 'missing_or_invalid_token', code: 400 };

  const ev = await Event.findById(tok.eventId).lean();
  if (!ev) return { error: 'event_not_found', code: 404 };

  const order = await Order.findById(tok.orderId);
  if (!order) return { error: 'order_not_found', code: 404 };
  if (String(order.eventId || order?.meta?.eventId || '') !== String(ev._id)) {
    return { error: 'order_event_mismatch', code: 400 };
  }
  // 'torelocate' : abonnement payé dont la place de ce match n'a pas pu être
  // attribuée (siège pris entre-temps). C'est précisément l'abonné qui a le
  // plus besoin de cette page — la refuser le laissait sans issue.
  if (!['paid', 'tobepaid', 'torelocate'].includes(String(order.status || '').toLowerCase())) {
    return { error: 'order_not_payable', code: 409 };
  }

  // Le lien expire au coup d'envoi (exp du JWT), mais un token forgé/rejoué
  // sans exp ne doit pas rouvrir la fenêtre : on revérifie sur l'évènement.
  if (ev.startsAt && Date.now() >= new Date(ev.startsAt).getTime()) {
    return { error: 'window_closed', code: 409 };
  }

  return { tok, ev, order };
}

// ---------- GET /s/seat-change?id=<jwt> ----------
router.get('/seat-change', async (req, res) => {
  try {
    const ctx = await loadContext(req.query.id || '');
    if (ctx.error) return res.status(ctx.code).json({ error: ctx.error });
    const { ev, order } = ctx;

    const lines = (order.lines || []).map((ln, i) => lineState(ln, i));
    const mySeatIds = new Set(lines.map(l => l.seatId).filter(Boolean));
    const myZones = new Set(lines.filter(l => l.changeable).map(l => l.zoneKey).filter(Boolean));

    const states = await computeEventSeatStates(ev);
    // Les sièges du porteur du lien sont 'booked' (par sa propre commande) :
    // ils doivent rester visibles comme SIENS, pas comme occupés par autrui.
    //
    // Sauf pour une commande 'torelocate' : justement, elle n'occupe rien. Le
    // siège inscrit sur ses lignes est celui qu'elle N'A PAS obtenu, et il est
    // désormais à quelqu'un d'autre. Le montrer comme disponible ferait cliquer
    // l'abonné sur la seule place qu'il ne peut pas prendre.
    const ownsItsSeats = String(order.status || '').toLowerCase() !== 'torelocate';
    const seats = states.map((s) => (
      ownsItsSeats && mySeatIds.has(s.seatId) ? { ...s, status: 'available', mine: true } : s
    ));

    res.json({
      ok: true,
      // Champs attendus par generic-view.js pour résoudre et peindre le plan
      // (il lit seasonCode/venueSlug/venueView/seats à la racine).
      seasonCode: ev.seasonCode,
      venueSlug: ev.venueSlug,
      venueView: ev.venueView || null,
      tariffs: [],
      prices: [],
      event: {
        id: String(ev._id),
        slug: ev.slug,
        name: ev.name || ev.slug,
        startsAt: ev.startsAt,
        venueSlug: ev.venueSlug,
        venueView: ev.venueView || null
      },
      order: { id: String(order._id) },
      lines,
      seats,
      // Le front n'autorise le clic que dans ces zones ; POST le revalide.
      allowedZones: Array.from(myZones),
      sameZoneOnly: true,
      deadline: ev.startsAt
    });
  } catch (e) {
    console.error('[GET /s/seat-change] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------- POST /s/seat-change?id=<jwt> ----------
// Body: { changes: [{ sourceLineId, toSeatId }] }
router.post('/seat-change', async (req, res) => {
  const claimed = [];
  try {
    const ctx = await loadContext(req.query.id || '');
    if (ctx.error) return res.status(ctx.code).json({ error: ctx.error });
    const { ev, order } = ctx;

    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (!changes.length) return res.status(400).json({ error: 'empty_changes' });

    const lines = (order.lines || []).map((ln, i) => lineState(ln, i));
    const bySourceId = new Map(lines.map(l => [l.sourceLineId, l]));

    // Un même siège cible ne peut pas servir deux fois dans la même requête.
    const targets = new Set();
    const planned = [];
    for (const change of changes) {
      const line = bySourceId.get(norm(change?.sourceLineId));
      const toSeatId = norm(change?.toSeatId);
      if (!line) return res.status(400).json({ error: 'unknown_line', sourceLineId: change?.sourceLineId });
      if (!toSeatId) return res.status(400).json({ error: 'missing_target', sourceLineId: line.sourceLineId });
      if (line.alreadyMoved) return res.status(409).json({ error: 'already_moved', sourceLineId: line.sourceLineId });
      if (!line.changeable) return res.status(409).json({ error: 'line_not_changeable', sourceLineId: line.sourceLineId });
      if (toSeatId === line.seatId) return res.status(400).json({ error: 'same_seat', sourceLineId: line.sourceLineId });
      if (targets.has(toSeatId)) return res.status(400).json({ error: 'duplicate_target', seatId: toSeatId });
      targets.add(toSeatId);
      planned.push({ line, toSeatId });
    }

    const states = await computeEventSeatStates(ev);
    const stateById = new Map(states.map(s => [s.seatId, s]));

    for (const { line, toSeatId } of planned) {
      const target = stateById.get(toSeatId);
      if (!target) return res.status(400).json({ error: 'unknown_seat', seatId: toSeatId });
      if (upper(target.zoneKey) !== line.zoneKey) {
        return res.status(403).json({ error: 'different_zone', seatId: toSeatId, from: line.zoneKey, to: upper(target.zoneKey) });
      }
      if (target.status !== 'available') {
        return res.status(409).json({ error: 'seat_unavailable', seatId: toSeatId, status: target.status });
      }
    }

    // Verrou : l'index unique {eventId, seatId} de SeatHold arbitre deux
    // abonnés qui visent la même place au même instant. Le hold n'est qu'un
    // sas — une fois l'override écrit, la commande elle-même occupe le siège.
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000);
    for (const { toSeatId } of planned) {
      try {
        await SeatHold.create({
          eventId: ev._id,
          seasonCode: ev.seasonCode,
          venueSlug: ev.venueSlug,
          seatId: toSeatId,
          reason: 'seat-change',
          sessionToken: `seat-change:${order._id}`,
          expiresAt
        });
        claimed.push(toSeatId);
      } catch {
        return res.status(409).json({ error: 'seat_unavailable', seatId: toSeatId });
      }
    }

    const applied = [];
    for (const { line, toSeatId } of planned) {
      const doc = order.lines[line.index];
      doc.attendance = applyAttendancePatch(
        doc,
        { status: 'moved', overrideSeatId: toSeatId, overrideZoneKey: line.zoneKey, note: 'self-service seat change' },
        new Date(),
        `subscriber:${order.payerEmail || order._id}`
      );
      applied.push({ sourceLineId: line.sourceLineId, from: line.seatId, to: toSeatId });
    }
    // Le PDF est rendu depuis order.meta.tickets (pas depuis les lignes) :
    // sans ce recalage, le billet réédité porterait encore l'ancienne place.
    // Les tickets meta sont appariés aux lignes par POSITION d'abord, donc
    // changer le seatId ici ne casse pas la résolution du bénéficiaire.
    const metaTickets = Array.isArray(order.meta?.tickets) ? order.meta.tickets : [];
    for (const move of applied) {
      for (const t of metaTickets) {
        if (String(t?.seatId || '') === move.from) t.seatId = move.to;
      }
    }
    order.markModified('lines');
    if (metaTickets.length) order.markModified('meta');
    // L'abonné vient de choisir une place : la commande cesse d'être « à
    // replacer » et redevient une commande de match ordinaire, qui occupe son
    // siège et donne droit au billet.
    if (String(order.status || '').toLowerCase() === 'torelocate') {
      order.status = 'paid';
      if (order.meta?.relocate) {
        order.meta = { ...order.meta, relocate: undefined };
        delete order.meta.relocate;
        order.markModified('meta');
      }
    }
    await order.save();
    // Le QR déjà envoyé reste valable : le contrôle d'accès résout le billet
    // par son hash puis lit le siège en base. Recaler Ticket.seatId suffit
    // donc pour que le portier voie la bonne place.
    for (const move of applied) {
      await Ticket.updateMany(
        { orderId: order._id, seatId: move.from },
        { $set: { seatId: move.to } }
      ).catch(() => {});
    }

    await SeatHold.deleteMany({ eventId: ev._id, seatId: { $in: claimed } }).catch(() => {});

    // Réédition du billet avec la nouvelle place. Le changement est déjà
    // committé : un échec d'envoi ne doit pas le faire échouer, on le signale
    // seulement pour que la page n'annonce pas un mail qui n'est pas parti.
    let ticketResent = false;
    try {
      ticketResent = Boolean(
        await sendOrderAttestationIfNeeded(order, { force: true, source: 'seat-change' })
      );
    } catch (err) {
      console.error('[seat-change] ticket resend failed:', err?.message || err);
    }

    res.json({ ok: true, applied, ticketResent });
  } catch (e) {
    console.error('[POST /s/seat-change] error:', e);
    // Ne pas laisser un siège verrouillé si l'écriture a échoué.
    if (claimed.length) {
      await SeatHold.deleteMany({ seatId: { $in: claimed }, reason: 'seat-change' }).catch(() => {});
    }
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
