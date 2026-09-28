// src/routes/admin/seat-state.routes.js
//
// Bascule d'un siège entre `available` et `busy` depuis admin/plan.
//
// À quoi cela sert : retirer une place de la vente sans passer par une
// commande — invitation à honorer plus tard, siège cassé, place réservée à la
// presse, rangée neutralisée pour un montage technique. Jusqu'ici il fallait
// un script (block-free-seats-for-season.js) et connaître le motif d'avance ;
// sur le plan, la place se désigne d'un clic.
//
// CE QU'ELLE NE TOUCHE JAMAIS :
//   - `booked` / `provisioned` : la place est à quelqu'un. La libérer ici
//     retirerait sa place à un abonné sans que rien ne le dise — c'est le
//     travail de la réallocation ou de l'annulation, qui préviennent.
//   - un `busy` tenu par une commande (`meta.hold.orderId`) : c'est un
//     paiement en cours. Le rendre disponible ferait atterrir le paiement sur
//     une place vendue à un autre entre-temps.
//
// Reste donc exactement deux transitions : available → busy, et le retour d'un
// busy posé à la main.
import { Router } from 'express';

import { Seat } from '../../models/Seat.js';
import { SeatHold } from '../../models/SeatHold.js';
import { Event } from '../../models/Event.js';
import { adminAuth } from './index.js';

// Un blocage de match se reconnaît à ce motif : il ne doit jamais être confondu
// avec un verrou de paiement (`reason: 'checkout'`), qu'on ne lève pas.
const ADMIN_BLOCK_REASON = 'admin-block';

// Jusqu'à quand tenir la place. Le TTL de SeatHold supprime le document tout
// seul : viser la fin du match évite d'avoir à nettoyer, et laisse de la marge
// pour un coup d'envoi retardé.
function blockUntilFor(eventDoc) {
  const start = eventDoc?.startsAt ? new Date(eventDoc.startsAt).getTime() : Date.now();
  return new Date(Math.max(start, Date.now()) + 12 * 60 * 60 * 1000);
}

const router = Router();
router.use(adminAuth);

const norm = v => String(v ?? '').trim();

router.post('/', async (req, res) => {
  try {
    const seasonCode = norm(req.body?.seasonCode);
    const venueSlug = norm(req.body?.venueSlug);
    const seatId = norm(req.body?.seatId);
    const to = norm(req.body?.to).toLowerCase();
    const note = norm(req.body?.note).slice(0, 200);

    if (!seasonCode || !venueSlug || !seatId) {
      return res.status(400).json({ ok: false, error: 'seasonCode, venueSlug et seatId sont requis' });
    }
    if (!['busy', 'available'].includes(to)) {
      return res.status(400).json({ ok: false, error: 'Cible attendue : busy ou available' });
    }

    const seat = await Seat.findOne({ seasonCode, venueSlug, seatId });
    if (!seat) {
      return res.status(404).json({ ok: false, error: `Place ${seatId} introuvable pour ${seasonCode} / ${venueSlug}` });
    }

    // ——— Portée MATCH : la place ne sort de la vente que pour cette rencontre.
    //
    // On ne touche pas à `Seat.status`, qui vaut pour la saison entière : on
    // pose un SeatHold, la même surcouche que lit la billetterie de l'événement
    // (computeEventSeatStates). Son index TTL fait le ménage tout seul.
    const eventRef = norm(req.body?.event);
    if (eventRef) {
      const eventDoc = /^[0-9a-f]{24}$/i.test(eventRef)
        ? await Event.findById(eventRef).lean()
        : await Event.findOne({ slug: eventRef }).lean();
      if (!eventDoc) {
        return res.status(404).json({ ok: false, error: `Événement introuvable : ${eventRef}` });
      }

      // Une place vendue ou promise reste hors de portée, match ou pas.
      if (seat.status === 'booked' || seat.status === 'provisioned') {
        return res.status(409).json({
          ok: false,
          error: `Place ${seatId} ${seat.status === 'booked' ? 'vendue' : 'provisionnée'} au niveau saison : un blocage de match n'y changerait rien.`,
          status: seat.status
        });
      }

      const existing = await SeatHold.findOne({ eventId: eventDoc._id, seatId }).lean();

      if (to === 'busy') {
        if (existing && existing.reason !== ADMIN_BLOCK_REASON) {
          return res.status(409).json({
            ok: false,
            error: `Place ${seatId} déjà retenue pour ce match (${existing.reason || 'motif inconnu'}${existing.orderId ? `, commande ${existing.orderId}` : ''}).`
          });
        }
        await SeatHold.updateOne(
          { eventId: eventDoc._id, seatId },
          { $set: {
            eventId: eventDoc._id, seatId,
            seasonCode: eventDoc.seasonCode, venueSlug: eventDoc.venueSlug,
            reason: ADMIN_BLOCK_REASON, sessionToken: '', orderId: null,
            expiresAt: blockUntilFor(eventDoc),
            note: note || ''
          } },
          { upsert: true }
        );
        return res.json({
          ok: true, changed: true, scope: 'event', seatId, status: 'busy',
          event: eventDoc.slug,
          message: `Place ${seatId} retirée de la vente pour ${eventDoc.slug} uniquement.`
        });
      }

      if (!existing) {
        return res.json({ ok: true, changed: false, scope: 'event', seatId, status: 'available',
          message: `Aucun blocage sur ${seatId} pour ce match.` });
      }
      // Ne lever QUE nos propres blocages : un verrou de paiement libéré ici
      // ferait atterrir l'encaissement sur une place revendue entre-temps.
      if (existing.reason !== ADMIN_BLOCK_REASON) {
        return res.status(409).json({
          ok: false,
          error: `Place ${seatId} retenue par « ${existing.reason || 'motif inconnu'} »${existing.orderId ? ` (commande ${existing.orderId})` : ''} : ce n'est pas un blocage manuel.`
        });
      }
      await SeatHold.deleteOne({ _id: existing._id });
      return res.json({
        ok: true, changed: true, scope: 'event', seatId, status: 'available',
        event: eventDoc.slug,
        message: `Place ${seatId} remise à la vente pour ${eventDoc.slug}.`
      });
    }

    const from = String(seat.status || 'available');
    if (from === to) {
      return res.json({ ok: true, changed: false, seatId, status: from, message: `Déjà « ${to} ».` });
    }

    // Une place vendue ou promise n'est pas à prendre depuis le plan.
    if (from === 'booked' || from === 'provisioned') {
      return res.status(409).json({
        ok: false,
        error: from === 'booked'
          ? `Place ${seatId} vendue : passer par la réallocation ou l'annulation de la commande.`
          : `Place ${seatId} provisionnée pour un renouveleur : passer par la réallocation.`,
        status: from,
        provisionedFor: seat.provisionedFor ? String(seat.provisionedFor) : null
      });
    }

    // Un blocage manuel n'a pas de meta.hold ; un checkout en cours, oui.
    const holdOrderId = seat.meta?.hold?.orderId ? String(seat.meta.hold.orderId) : '';
    if (from === 'busy' && holdOrderId) {
      return res.status(409).json({
        ok: false,
        error: `Place ${seatId} retenue par un paiement en cours (commande ${holdOrderId}) : la libérer ferait échouer ce paiement.`,
        status: from,
        holdOrderId
      });
    }
    if (from === 'held') {
      return res.status(409).json({ ok: false, error: `Place ${seatId} en état « held » : à traiter par l'outil qui l'a posé.`, status: from });
    }

    seat.status = to;
    seat.meta = seat.meta || {};
    if (to === 'busy') {
      // Trace du blocage manuel : sans elle, impossible de distinguer plus tard
      // une place neutralisée exprès d'une place bloquée par accident.
      seat.meta.manualBlock = { at: new Date(), by: 'admin-plan', note: note || '' };
    } else {
      seat.meta.manualBlock = undefined;
      seat.meta.hold = undefined;
    }
    seat.markModified('meta');
    await seat.save();

    return res.json({
      ok: true, changed: true, seatId, from, status: to,
      message: to === 'busy'
        ? `Place ${seatId} retirée de la vente.`
        : `Place ${seatId} remise à la vente.`
    });
  } catch (err) {
    console.error('[admin/seat-state]', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Erreur serveur' });
  }
});

export default router;
