// src/routes/admin/order-seat.routes.js
// Réallocation d'un siège sur une commande de saison (abonnement / renouvellement).
//
// Contrairement à « Ajuster » (l'overlay de présence d'un match, qui n'écrit
// que line.attendance), ce point d'entrée déplace les VRAIS documents Seat :
// l'ancien redevient disponible, le nouveau prend l'état de l'ancien. Sans
// cela on obtiendrait l'incohérence classique — ancienne place toujours
// bloquée, nouvelle place encore en vente.
//
// Aucun e-mail n'est envoyé : le renvoi d'attestation reste une action à part.
import { Router } from 'express';
import mongoose from 'mongoose';

import { Order, Seat, Zone } from '../../models/index.js';
import { allocateZoneSeatIds } from '../../services/zone-seat-ids.js';
import { adminAuth } from './index.js';

const router = Router();
router.use(adminAuth);

const norm = v => String(v ?? '').trim();
const normSeat = v => norm(v).toUpperCase();

// Les états qui signalent que la place n'est pas libre. On ne les refuse pas
// définitivement — l'admin doit pouvoir trancher — mais jamais en silence.
const OCCUPIED = ['booked', 'busy', 'held', 'provisioned'];

const SEASON_FLOWS = ['subscription', 'renew'];

function describeSeat(seat) {
  if (!seat) return null;
  return {
    seatId: seat.seatId,
    status: seat.status || 'available',
    zoneKey: seat.zoneKey || '',
    provisionedFor: seat.provisionedFor ? String(seat.provisionedFor) : null,
    holdOrderId: seat.meta?.hold?.orderId ? String(seat.meta.hold.orderId) : null,
    holdUntil: seat.meta?.hold?.until || null
  };
}

async function occupancyWarning(seat, order) {
  if (!seat || !OCCUPIED.includes(seat.status)) return null;
  const parts = [];
  if (seat.status === 'booked') parts.push('déjà vendue et payée');
  if (seat.status === 'busy') parts.push(`en cours de paiement (commande ${seat.meta?.hold?.orderId || '?'})`);
  if (seat.status === 'held') parts.push('retenue');
  if (seat.status === 'provisioned') {
    parts.push(seat.provisionedFor
      ? `provisionnée pour le renouveleur ${seat.provisionedFor}`
      : 'provisionnée pour un renouvellement');
  }
  // Le siège tenu par CETTE commande n'est pas un conflit : c'est son état normal.
  const heldBySelf = seat.meta?.hold?.orderId && String(seat.meta.hold.orderId) === String(order._id);
  if (heldBySelf) return null;
  return `Place ${seat.seatId} ${parts.join(', ')}.`;
}

// Une place vendue sur un match a pu être dérivée de l'abonnement
// (sync-season-orders-to-event). Déplacer la place de saison ne déplace pas
// ces commandes-là : il faut le dire, pas le corriger dans le dos.
async function derivedEventUsage(order, seatId) {
  const derived = await Order.find({
    parentOrderId: order._id,
    status: { $in: ['paid', 'tobepaid', 'pending'] },
    'lines.seatId': seatId
  }, { _id: 1, eventId: 1, status: 1 }).lean();
  return derived.map(d => ({ orderId: String(d._id), eventId: d.eventId ? String(d.eventId) : null, status: d.status }));
}

router.get('/:orderId', async (req, res) => {
  const orderId = norm(req.params.orderId);
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    return res.status(400).json({ ok: false, error: 'Identifiant de commande invalide' });
  }
  const order = await Order.findById(orderId).lean();
  if (!order) return res.status(404).json({ ok: false, error: 'Commande introuvable' });

  const seatIds = (order.lines || []).map(l => normSeat(l.seatId)).filter(Boolean);
  const seats = seatIds.length
    ? await Seat.find({ seasonCode: order.seasonCode, venueSlug: order.venueSlug, seatId: { $in: seatIds } }).lean()
    : [];
  const byId = new Map(seats.map(s => [normSeat(s.seatId), s]));

  return res.json({
    ok: true,
    order: {
      id: String(order._id),
      status: order.status || '',
      flow: order.origin?.flow || '',
      seasonCode: order.seasonCode || '',
      venueSlug: order.venueSlug || '',
      payerEmail: order.payerEmail || '',
      lines: (order.lines || []).map((l, index) => ({
        index,
        unitType: l.unitType || '',
        seatId: l.seatId || '',
        zoneKey: l.zoneKey || '',
        tariffCode: l.tariffCode || '',
        priceCents: l.priceCents || 0,
        holder: [l.holderFirstName, l.holderLastName].filter(Boolean).join(' '),
        seat: describeSeat(byId.get(normSeat(l.seatId)))
      }))
    }
  });
});

router.post('/:orderId', async (req, res) => {
  try {
    const orderId = norm(req.params.orderId);
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ ok: false, error: 'Identifiant de commande invalide' });
    }
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ ok: false, error: 'Commande introuvable' });

    const flow = order.origin?.flow || '';
    if (!SEASON_FLOWS.includes(flow)) {
      return res.status(400).json({
        ok: false,
        error: `Réallocation réservée aux commandes de saison (flux « ${flow || 'inconnu'} »). Pour un match, utiliser « Ajuster ».`
      });
    }

    const { lineIndex, targetSeatId, targetZoneKey, force, commit = true } = req.body || {};
    const index = Number(lineIndex);
    const lines = order.lines || [];
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
      return res.status(400).json({ ok: false, error: `Ligne inconnue : ${lineIndex}` });
    }
    const line = lines[index];
    const scopeEarly = { seasonCode: order.seasonCode, venueSlug: order.venueSlug };
    const wasZoneLine = (line.unitType || '') === 'zone';

    // --- Reloger vers une ZONE (place debout) plutôt que vers un siège.
    //
    // Une place en zone n'a pas de document Seat : son identifiant est virtuel
    // (« DEBOUT-Z001 »). Reloger vers une zone consiste donc à rendre le siège
    // d'origine et à réécrire la ligne, pas à réserver quoi que ce soit.
    const toZoneKey = normSeat(targetZoneKey);
    if (toZoneKey) {
      const zone = await Zone.findOne({ ...scopeEarly, key: toZoneKey }).lean();
      if (!zone) {
        return res.status(404).json({ ok: false, error: `Zone ${toZoneKey} introuvable pour ${order.seasonCode} / ${order.venueSlug}.` });
      }
      const previousSeatId = normSeat(line.seatId);
      const [virtualId] = await allocateZoneSeatIds({
        ...scopeEarly, zoneKey: toZoneKey, count: 1
      });

      if (!commit) {
        return res.json({
          ok: true, changed: false, dryRun: true,
          from: previousSeatId || '(place en zone)', to: virtualId, toZoneKey,
          message: 'Simulation : relancer avec commit pour écrire.'
        });
      }

      // Le siège d'origine n'est rendu que s'il en existait un ET qu'il
      // appartenait bien à cette commande.
      let released = 0;
      if (previousSeatId && !wasZoneLine) {
        const upd = await Seat.updateMany(
          { ...scopeEarly, seatId: previousSeatId },
          { $set: { status: 'available', provisionedFor: null }, $unset: { 'meta.hold': 1 } }
        );
        released = Number(upd.modifiedCount ?? upd.nModified ?? 0);
      }

      line.seatId = virtualId;
      line.zoneKey = toZoneKey;
      line.zoneType = zone.type || line.zoneType || null;
      line.unitType = 'zone';
      order.markModified('lines');
      order.adminEdits = [...(order.adminEdits || []), {
        at: new Date(), by: 'admin-ui', kind: 'seat-move',
        changes: [`ligne ${index + 1} : ${previousSeatId || '(zone)'} → zone ${toZoneKey} (${virtualId})`]
      }];
      order.markModified('adminEdits');
      await order.save();

      return res.json({
        ok: true, changed: true,
        from: previousSeatId || '(place en zone)', to: virtualId, toZoneKey,
        releasedSeats: released,
        warnings: [
          `Le tarif (${line.tariffCode || '—'}) n'a pas été modifié : un passage en zone change souvent le prix, à vérifier.`,
          'La place occupe désormais un quota de zone ; aucun siège ne lui est réservé.'
        ],
        message: 'Place relogée en zone. Aucun e-mail n\'a été envoyé.'
      });
    }

    // --- Reloger vers un SIÈGE. Une ligne de zone est acceptée : c'est
    // l'inverse du cas ci-dessus (un abonné debout qui obtient une place
    // assise). Elle n'a pas de siège à rendre, seulement un quota à libérer.
    const fromSeatId = normSeat(line.seatId);
    const toSeatId = normSeat(targetSeatId);
    if (!toSeatId) return res.status(400).json({ ok: false, error: 'Place de destination manquante' });
    if (toSeatId === fromSeatId) {
      return res.status(400).json({ ok: false, error: 'La place de destination est déjà celle de la ligne.' });
    }

    const scope = { seasonCode: order.seasonCode, venueSlug: order.venueSlug };
    const [fromSeat, toSeat] = await Promise.all([
      fromSeatId ? Seat.findOne({ ...scope, seatId: fromSeatId }) : null,
      Seat.findOne({ ...scope, seatId: toSeatId })
    ]);

    if (!toSeat) {
      return res.status(404).json({
        ok: false,
        error: `Place ${toSeatId} introuvable pour ${order.seasonCode} / ${order.venueSlug}.`
      });
    }

    const warning = await occupancyWarning(toSeat, order);
    const derived = fromSeatId ? await derivedEventUsage(order, fromSeatId) : [];

    // Le cœur de la demande : on alerte, on n'interdit pas. Sans --force on
    // rend le diagnostic complet pour que la décision soit prise en connaissance
    // de cause, et rien n'est écrit.
    if ((warning || derived.length) && !force) {
      return res.status(409).json({
        ok: false,
        needsForce: true,
        error: warning || `La place ${fromSeatId} est utilisée par ${derived.length} commande(s) de match dérivée(s).`,
        occupancy: describeSeat(toSeat),
        derivedEventOrders: derived,
        hint: 'Relancer en confirmant pour passer outre.'
      });
    }

    // L'état de la commande commande l'état du siège : une commande payée
    // occupe (booked), une commande en cours tient (busy).
    const targetStatus = order.status === 'paid' ? 'booked' : 'busy';

    if (fromSeat) {
      fromSeat.status = 'available';
      fromSeat.provisionedFor = null;
      if (fromSeat.meta?.hold) fromSeat.meta.hold = undefined;
      await fromSeat.save();
    }

    toSeat.status = targetStatus;
    toSeat.provisionedFor = null;
    if (toSeat.meta?.hold) toSeat.meta.hold = undefined;
    await toSeat.save();

    // La zone du nouveau siège peut différer : elle est recopiée sur la ligne,
    // sinon les billets et les plans repartiraient sur l'ancienne zone. Le
    // TARIF, lui, n'est jamais touché — changer le prix d'une commande payée
    // est une décision comptable, pas un effet de bord d'un déplacement.
    const newZoneKey = normSeat(toSeat.zoneKey || line.zoneKey || '');
    const zoneChanged = newZoneKey && newZoneKey !== normSeat(line.zoneKey || '');
    let newZoneType = line.zoneType || null;
    if (zoneChanged) {
      const zone = await Zone.findOne({ ...scope, key: newZoneKey }).lean();
      newZoneType = zone?.type || newZoneType;
    }

    line.seatId = toSeat.seatId;
    if (newZoneKey) line.zoneKey = newZoneKey;
    if (newZoneType) line.zoneType = newZoneType;
    // Une place debout qui devient une place assise cesse d'être une ligne de
    // zone : la laisser en `zone` lui ferait occuper à la fois un siège et un
    // quota de zone, et les compteurs de zone la retiendraient pour toujours.
    line.unitType = 'seat';
    order.markModified('lines');

    order.adminEdits = [...(order.adminEdits || []), {
      at: new Date(),
      by: 'admin-ui',
      kind: 'seat-move',
      changes: [
        `ligne ${index + 1} : ${fromSeatId || '(vide)'} → ${toSeat.seatId}`,
        ...(zoneChanged ? [`zone ${line.zoneKey}`] : []),
        ...(force && warning ? [`forcé (${warning})`] : []),
        ...(derived.length ? [`${derived.length} commande(s) de match dérivée(s) non déplacée(s)`] : [])
      ]
    }];
    order.markModified('adminEdits');
    await order.save();

    return res.json({
      ok: true,
      changed: true,
      from: fromSeatId,
      to: toSeat.seatId,
      seatStatus: targetStatus,
      zoneChanged: Boolean(zoneChanged),
      forced: Boolean(force && warning),
      derivedEventOrders: derived,
      warnings: [
        ...(wasZoneLine ? ['La place occupait un quota de zone : il est rendu, et un siège est désormais réservé.'] : []),
        ...(zoneChanged ? [`La zone passe à ${line.zoneKey} : le tarif (${line.tariffCode || '—'}) n'a pas été modifié, à vérifier.`] : []),
        ...(derived.length ? [`${derived.length} commande(s) de match dérivée(s) pointent encore sur ${fromSeatId} : les régénérer.`] : [])
      ],
      message: 'Place déplacée. Aucun e-mail n\'a été envoyé.'
    });
  } catch (err) {
    console.error('[admin/order-seat]', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Erreur serveur' });
  }
});

export default router;
