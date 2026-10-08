// src/services/event-seat-holds.js
//
// Verrou de siège propre à un évènement, partagé par tous les flux qui
// réservent des places (achat, réservation partenaire, retrait d'un bon
// cadeau). Une seule implémentation : deux variantes de cette arbitrage
// finiraient par diverger et vendre deux fois la même place.

import { SeatHold } from '../models/SeatHold.js';
import { Order } from '../models/Order.js';
import { Seat } from '../models/Seat.js';

/**
 * Rend TOUTES les places tenues par une commande : le verrou d'évènement
 * (SeatHold) et le hold historique (Seat.meta.hold).
 *
 * POURQUOI ICI. Trois endroits libéraient ces places, et aucun ne le faisait
 * pareil. La sentinelle ne touchait que `Seat` — or c'est `SeatHold` que lit
 * le plan de salle, donc une commande annulée continuait d'afficher ses places
 * prises jusqu'à l'expiration du TTL. Et son filtre portait `order._id`, un
 * ObjectId, alors que les trois flux d'achat écrivent `String(order._id)` dans
 * un champ `Mixed` : Mongoose ne convertit rien, le filtre ne correspondait à
 * RIEN, et la sentinelle n'a jamais libéré un seul siège (ses journaux le
 * disent : `released: 0`). On accepte donc les deux formes, et il n'y a plus
 * qu'une implémentation à relire.
 *
 * Écrit au mieux : libérer des places ne doit jamais faire tomber l'appelant,
 * qui est toujours en train de traiter un échec ou une annulation.
 *
 * @param {object} order  commande (ou objet lean) portant _id, seasonCode, venueSlug, lines
 * @returns {Promise<{holds:number, seats:number}>} ce qui a effectivement été rendu
 */
export async function releaseOrderSeatHolds(order) {
  const orderId = order?._id;
  if (!orderId) return { holds: 0, seats: 0 };

  let holds = 0;
  try {
    const del = await SeatHold.deleteMany({ orderId });
    holds = Number(del?.deletedCount || 0);
  } catch { /* le hold historique reste à tenter */ }

  const seatIds = (order.lines || [])
    .map(l => String(l?.seatId || '').trim())
    .filter(Boolean);
  if (!seatIds.length) return { holds, seats: 0 };

  let seats = 0;
  try {
    const upd = await Seat.updateMany(
      {
        seasonCode: order.seasonCode,
        venueSlug: order.venueSlug,
        seatId: { $in: seatIds },
        status: 'busy',
        // Les deux écritures rencontrées en base : chaîne (flux d'achat) et
        // ObjectId (écritures plus anciennes).
        $or: [
          { 'meta.hold.orderId': String(orderId) },
          { 'meta.hold.orderId': orderId }
        ]
      },
      { $set: { status: 'available' }, $unset: { 'meta.hold': 1 } },
      { runValidators: false }
    );
    seats = Number(upd?.modifiedCount ?? upd?.nModified ?? 0);
  } catch { /* au mieux */ }

  return { holds, seats };
}

/**
 * Consigne sur une commande devenue caduque qu'une commande plus récente lui a
 * repris une place. Ne touche que les commandes encore ouvertes : une commande
 * payée n'est jamais « dépassée », et son verrou ne doit pas être réinterprété.
 *
 * Écrit au mieux : un échec ici ne doit pas faire tomber un encaissement.
 */
async function markSuperseded(previousOrderId, newOrderId, seatId) {
  try {
    await Order.updateOne(
      { _id: previousOrderId, status: { $in: ['pending', 'tobepaid'] } },
      {
        $set: {
          'paymentProviderMeta.supersededBy': String(newOrderId),
          'paymentProviderMeta.supersededAt': new Date()
        },
        $addToSet: { 'paymentProviderMeta.supersededSeats': seatId }
      }
    );
  } catch { /* traçabilité seulement */ }
}

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

    // Un verrou posé par la MÊME session appartient peut-être encore à une
    // commande précédente : c'est le cas quand le client revient en arrière et
    // change sa sélection. Le verrou lui est repris ici — et l'ancienne
    // commande, elle, reste « pending » AVEC UN LIEN DE PAIEMENT VALIDE. Si le
    // client paie ce lien-là, sa finalisation trouve la place tenue par la
    // nouvelle commande, échoue en `seat_conflict` et lui annonce qu'« une de
    // ses places vient d'être réservée » — alors que c'est lui qui l'a reprise.
    // On note donc la filiation sur la commande dépassée, pour que le motif
    // soit lisible au lieu d'accuser un tiers.
    const previous = await SeatHold.findOne(
      { eventId: ev._id, seatId, $or: mine },
      { orderId: 1 }
    ).lean();

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
    if (upd.matchedCount || upd.modifiedCount) {
      const takenFrom = previous?.orderId ? String(previous.orderId) : '';
      if (takenFrom && takenFrom !== String(order._id)) {
        await markSuperseded(takenFrom, order._id, seatId);
      }
      claimed.push(seatId);
      continue;
    }

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

