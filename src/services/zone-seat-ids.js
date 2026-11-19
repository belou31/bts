// src/services/zone-seat-ids.js
//
// Attribution des identifiants VIRTUELS des places en zone (« DEBOUT-Z001 »).
//
// Une place debout n'a pas de document Seat : rien, au niveau du siège, ne dit
// qu'elle est prise. L'identifiant virtuel tient ce rôle — il apparaît sur le
// billet, sert de clé aux quotas de zone et permet de reconnaître une place
// déjà renouvelée. Deux places ne doivent donc jamais porter le même.
//
// Extrait de routes/renew.js pour être partagé avec la réallocation
// administrative : deux allocateurs distincts finiraient par attribuer le même
// numéro, ce qui est précisément ce que cet identifiant doit empêcher.
import { Order } from '../models/Order.js';
import { Subscriber } from '../models/Subscriber.js';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rend `count` identifiants libres pour cette zone.
 *
 * Les numéros déjà pris sont relevés dans les commandes vivantes ET dans
 * `Subscriber.prefSeatId` : une place promise à un renouveleur qui n'a pas
 * encore payé n'apparaît nulle part ailleurs.
 */
export async function allocateZoneSeatIds({ seasonCode, venueSlug, zoneKey, count = 1 }) {
  const key = String(zoneKey || '').toUpperCase();
  const rx = new RegExp(`^${escapeRegex(key)}-Z(\\d{3,})$`, 'i');
  const used = new Set();

  const orders = await Order.find(
    { seasonCode, venueSlug, status: { $nin: ['canceled', 'failed'] }, 'lines.zoneKey': key },
    { 'lines.seatId': 1 }
  ).lean();
  for (const ord of orders) {
    for (const line of (ord.lines || [])) {
      const m = rx.exec(String(line?.seatId || ''));
      if (m) used.add(Number(m[1]));
    }
  }

  const subs = await Subscriber.find(
    { seasonCode, venueSlug, prefSeatId: rx },
    { prefSeatId: 1 }
  ).lean();
  for (const sub of subs) {
    const m = rx.exec(String(sub?.prefSeatId || ''));
    if (m) used.add(Number(m[1]));
  }

  const out = [];
  for (let n = 1; out.length < count; n++) {
    if (used.has(n)) continue;
    used.add(n);
    out.push(`${key}-Z${String(n).padStart(3, '0')}`);
  }
  return out;
}
