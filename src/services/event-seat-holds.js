// src/services/event-seat-holds.js
//
// Verrou de siège propre à un évènement, partagé par tous les flux qui
// réservent des places (achat, réservation partenaire, retrait d'un bon
// cadeau). Une seule implémentation : deux variantes de cette arbitrage
// finiraient par diverger et vendre deux fois la même place.

import { SeatHold } from '../models/SeatHold.js';

/**
 * Réserve les sièges d'une commande évènement via SeatHold, dont l'index
 * unique {eventId, seatId} tranche deux acheteurs simultanés.
 *
 * Le hold historique (Seat.meta.hold) ne peut pas jouer ce rôle : il est posé
 * avec le filtre `status != 'booked'`, or une place rendue par un abonné pour
 * CE match reste 'booked' au niveau saison (il la garde pour les autres). Ces
 * places-là n'étaient donc jamais verrouillées : deux acheteurs pouvaient
 * payer la même, et le second ne l'apprenait qu'à la finalisation — après
 * encaissement. SeatHold est propre à l'évènement, donc juste pour ce cas.
 *
 * @returns {Promise<{ok: boolean, conflicts: string[], claimed: string[]}>}
 */
export async function claimEventSeatHolds({ ev, order, seatIds, sessionToken, until }) {
  const claimed = [];
  const conflicts = [];

  for (const seatId of seatIds) {
    // Récupère d'abord le hold que CETTE session a posé pendant la sélection,
    // pour le convertir en hold de commande sans fenêtre où il n'existe plus.
    const mine = [{ orderId: order._id }];
    if (sessionToken) mine.push({ sessionToken });

    const upd = await SeatHold.updateOne(
      { eventId: ev._id, seatId, $or: mine },
      {
        $set: {
          orderId: order._id,
          seasonCode: ev.seasonCode,
          venueSlug: ev.venueSlug,
          reason: 'checkout',
          expiresAt: until
        }
      }
    );
    if (upd.matchedCount || upd.modifiedCount) { claimed.push(seatId); continue; }

    try {
      await SeatHold.create({
        eventId: ev._id,
        seasonCode: ev.seasonCode,
        venueSlug: ev.venueSlug,
        seatId,
        orderId: order._id,
        sessionToken: sessionToken || '',
        reason: 'checkout',
        expiresAt: until
      });
      claimed.push(seatId);
    } catch {
      conflicts.push(seatId); // index unique → quelqu'un d'autre tient la place
    }
  }

  if (conflicts.length && claimed.length) {
    // Ne relâcher que ce que CETTE commande vient de prendre.
    await SeatHold.deleteMany({ eventId: ev._id, orderId: order._id, seatId: { $in: claimed } }).catch(() => {});
  }
  return { ok: conflicts.length === 0, conflicts, claimed };
}

