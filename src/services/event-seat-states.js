// src/services/event-seat-states.js
//
// Per-event seat availability. An event never books seats in the `Seat`
// collection (that collection tracks the SEASON); an event's occupancy is an
// overlay computed from its paid orders, which is what makes a per-event seat
// change possible at all — moving someone for one match must not disturb the
// season allocation.
//
// Extracted from event-flow.factory.js so the seat-change flow scores
// availability with exactly the same rules the booking flow does: two
// implementations would inevitably disagree about what "free" means and
// double-sell a seat.

import { Seat } from '../models/Seat.js';
import { Order } from '../models/Order.js';
import { SeatHold } from '../models/SeatHold.js';
import { resolveLinePlacement } from '../utils/event-attendance.js';
import { isVirtualZoneSeatId } from '../utils/seat-id.js';

// ---------------------------------------------------------------------------
// Cache de la base, par évènement.
//
// Le calcul se fait en deux temps, et un seul est coûteux :
//   — la BASE (tous les sièges de la salle + la surcouche des commandes
//     payées) : deux requêtes lourdes, identiques pour tous les visiteurs ;
//   — les VERROUS de sélection (SeatHold), qui dépendent du jeton de session
//     de celui qui regarde et se lisent par un index.
//
// Seule la base est mise en cache, et seulement là où l'appelant le DEMANDE
// (`cacheMs`). Par défaut il n'y a pas de cache : la détection de conflit à la
// finalisation et la validation du panier à l'achat lisent cette même
// fonction, et leur servir un état même légèrement périmé rouvrirait la porte
// à la double vente. Ce sont les deux chemins d'AFFICHAGE qui demandent un
// cache, parce qu'eux sont appelés par chaque navigateur ouvert toutes les
// cinq secondes.
const baseCache = new Map(); // eventId -> { at: number, rows: Array<{seatId, zoneKey, status}> }

/** Oublie la base d'un évènement : à appeler dès qu'une commande le modifie. */
export function invalidateEventSeatStates(eventId) {
  if (!eventId) return;
  baseCache.delete(String(eventId));
}

function readBaseCache(key, cacheMs) {
  if (!(cacheMs > 0) || !key) return null;
  const hit = baseCache.get(key);
  if (!hit || Date.now() - hit.at >= cacheMs) return null;
  // Copie : les surcouches qui suivent écrivent dans ces objets, et muter
  // l'entrée mise en cache contaminerait le visiteur suivant.
  return new Map(hit.rows.map(r => [r.seatId, { ...r }]));
}

function writeBaseCache(key, cacheMs, byId) {
  if (!(cacheMs > 0) || !key) return;
  const now = Date.now();
  // Purge paresseuse : sans elle, un serveur qui voit passer beaucoup
  // d'évènements garderait une entrée par évènement indéfiniment.
  for (const [k, v] of baseCache) {
    if (now - v.at >= Math.max(cacheMs * 10, 60_000)) baseCache.delete(k);
  }
  baseCache.set(key, { at: now, rows: Array.from(byId.values()).map(r => ({ ...r })) });
}

/**
 * @param {object} ev  Event document (needs _id, seasonCode, venueSlug)
 * @param {string} [sessionToken]  Holds owned by this session stay 'available'
 * @param {object} [opts]
 * @param {number} [opts.cacheMs=0]  réutilise la base si elle a moins de `cacheMs`.
 *   À NE PAS utiliser pour arbitrer une vente — seulement pour afficher.
 * @returns {Promise<Array<{seatId:string, zoneKey:string, status:string}>>}
 */
export async function computeEventSeatStates(ev, sessionToken = '', { cacheMs = 0 } = {}) {
  const cacheKey = String(ev?._id || '');
  const cached = readBaseCache(cacheKey, cacheMs);
  if (cached) return applyHoldOverlay(ev, cached, sessionToken);

  const byId = await computeBaseSeatStates(ev);
  writeBaseCache(cacheKey, cacheMs, byId);
  return applyHoldOverlay(ev, byId, sessionToken);
}

/** La partie coûteuse et indépendante du visiteur. */
async function computeBaseSeatStates(ev) {
  // Base: états des sièges pour la saison/lieu (provisions/holds abonnements, VIP, etc.)
  const base = await Seat.find(
    { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug },
    { seatId: 1, zoneKey: 1, status: 1, _id: 0 }
  ).lean();

  const byId = new Map(base.map(s => [String(s.seatId), { seatId: s.seatId, zoneKey: s.zoneKey, status: String(s.status || 'available').toLowerCase() }]));

  // Surcouche: ordres paid/tobepaid pour CET évènement -> booked
  const paid = await Order.find(
    {
      status: { $in: ['paid', 'tobepaid'] },
      $or: [
        { eventId: ev._id },
        { 'meta.eventId': String(ev._id) }
      ]
    },
    { lines: 1, _id: 0 }
  ).lean();

  // Deux ensembles, calculés avant d'écrire quoi que ce soit : où les gens
  // sont RÉELLEMENT assis pour ce match, et les sièges qu'ils ont quittés.
  const occupied = new Set();
  const vacated = new Set();

  for (const ord of (paid || [])) {
    for (const ln of (ord.lines || [])) {
      const placement = resolveLinePlacement(ln);
      const origin = String(ln?.seatId || '').trim();
      const target = String(placement.seatId || '').trim();

      // Siège d'origine libéré pour ce match (place rendue, ou déplacement).
      if (origin && origin !== target && !isVirtualZoneSeatId(origin)) vacated.add(origin);

      if (placement.released) continue;
      if (!target) continue;                    // lignes de zone → pas de seatId
      if (isVirtualZoneSeatId(target)) continue; // IDs virtuels (zones) → ignorer
      occupied.add(target);
    }
  }

  // Un siège vendu à l'abonnement est 'booked' dans Seat pour TOUTE la saison :
  // sans ce passage, la place rendue par un abonné pour CE match resterait
  // affichée occupée et personne ne pourrait la reprendre. On ne libère que ce
  // qui a été explicitement quitté pour cet évènement, et uniquement un statut
  // 'booked' (une place 'busy'/bloquée l'est délibérément — VIP, blocage
  // manuel — et doit le rester).
  for (const sid of vacated) {
    if (occupied.has(sid)) continue;
    const rec = byId.get(sid);
    if (!rec || rec.status !== 'booked') continue;
    rec.status = 'available';
    byId.set(sid, rec);
  }

  for (const sid of occupied) {
    if (!byId.has(sid)) continue;       // ⛔ ne crée PAS de siège fantôme
    const rec = byId.get(sid);
    rec.status = 'booked';
    byId.set(sid, rec);
  }

  return byId;
}

/**
 * Surcouche: SeatHold actifs (sélections en cours d'autres sessions) -> busy.
 *
 * JAMAIS mise en cache : elle dépend du visiteur (ses propres verrous doivent
 * lui rester disponibles) et c'est la couche qui change le plus vite — une
 * sélection apparaît et disparaît en quelques secondes. La requête est servie
 * par l'index {eventId, seatId}, son coût est négligeable devant la base.
 */
async function applyHoldOverlay(ev, byId, sessionToken) {
  const holds = await SeatHold.find(
    { eventId: ev._id, expiresAt: { $gt: new Date() } },
    { seatId: 1, sessionToken: 1, _id: 0 }
  ).lean();

  for (const hold of holds) {
    const sid = String(hold.seatId || '').trim();
    if (!sid) continue;
    if (sessionToken && hold.sessionToken === sessionToken) continue; // propre sélection → reste available
    if (!byId.has(sid)) continue;
    const rec = byId.get(sid);
    if (rec.status === 'available') {
      rec.status = 'busy';
      byId.set(sid, rec);
    }
  }

  return Array.from(byId.values());
}
