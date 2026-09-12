// scripts/lib/order-cancel.js
//
// Fond commun aux deux scripts d'annulation — saison et événement.
//
// Ce qui est identique des deux côtés vit ici : désigner les commandes, refuser
// une commande payée sans insistance, révoquer les billets, résumer. Ce qui
// diffère reste dans chaque script, parce que ce sont deux gestes différents :
//
//   saison    — la place est détenue à l'année. L'annuler, c'est la rendre à
//               la vente pour toute la saison.
//   événement — la place n'est prise que pour ce match. L'annuler, c'est poser
//               `released` sur la ligne ; le siège de saison, lui, ne bouge pas
//               quand la commande dérive d'un abonnement.
//
// Le tri se fait sur `eventId`, pas sur `origin.flow` : les flux `event`,
// `partner` et `voucher` portent tous un eventId, tandis que `subscription`,
// `renew` et `voucher-purchase` n'en ont pas.
import mongoose from 'mongoose';
import { readCsv } from '../_utils.js';

export const CANCELED = 'canceled';   // l'enum d'Order dit bien 'canceled', pas 'cancelled'

export function isObjectId(v) {
  return mongoose.isValidObjectId(String(v || ''));
}

/**
 * Liste des commandes à traiter : soit un identifiant, soit un CSV
 * (colonnes orderId, mode). Les deux ensemble sont refusés.
 */
export async function resolveTargets({ order, file, mode = 'soft' }) {
  if (!order && !file) throw new Error('Préciser --order=<id> ou --file=<csv>');
  if (order && file) throw new Error('Un seul mode à la fois : --order ou --file');
  if (order) return [{ orderId: String(order).trim(), mode }];
  const rows = await readCsv(file);
  return rows
    .map(r => ({ orderId: String(r.orderId || '').trim(), mode: String(r.mode || 'soft').toLowerCase() }))
    .filter(r => r.orderId);
}

/** Commande par identifiant, avec repli sur l'identifiant hérité. */
export async function loadOrder(Order, id) {
  if (isObjectId(id)) {
    const byId = await Order.findById(id);
    if (byId) return byId;
  }
  return Order.findOne({ 'paymentProviderMeta.legacyOrderId': id });
}

/**
 * Les billets sont SUPPRIMÉS, jamais marqués : `Ticket` n'a pas de champ
 * `status` et son schéma est strict, si bien qu'un $set y est écarté en
 * silence — une commande annulée gardait des billets parfaitement scannables.
 * C'est aussi ainsi que le reste du code les révoque (event-season-sync.js,
 * delete-event.js).
 */
export async function revokeTickets(Ticket, order) {
  const res = await Ticket.deleteMany({ orderId: order._id });
  return Number(res.deletedCount ?? 0);
}

/**
 * Une commande payée correspond à de l'argent encaissé : la traiter sans le
 * dire est le genre d'action qu'on regrette. Rend true si on doit passer.
 */
export function shouldSkipPaid(order, force) {
  if (order.status !== 'paid' || force) return false;
  console.log('  ⛔ commande PAYÉE — ignorée. Ajouter --force pour la traiter malgré tout.');
  return true;
}

export function describeOrder(order, seatIds) {
  console.log(`\n${order._id}`);
  console.log(`  statut : ${order.status} · ${order.origin?.flow || '—'} · ${(order.totalCents || 0) / 100} €`
    + ` · ${order.payerEmail || '—'}`);
  console.log(`  places : ${seatIds.length ? seatIds.join(', ') : '(aucune place identifiée)'}`);
}

/**
 * Places identifiées d'une commande. Les lignes ZONE n'ont pas de document
 * Seat : seules les places nommées peuvent être rendues à la vente.
 */
export function realSeatIds(order) {
  return (order.lines || [])
    .filter(l => (l.unitType || '') !== 'zone')
    .map(l => String(l.seatId || '').trim())
    .filter(Boolean);
}

/** Passage à `canceled` avec sa date, sans enregistrer. */
export function markCanceled(order) {
  order.status = CANCELED;
  order.meta = order.meta || {};
  order.meta.canceledAt = new Date();
  if (Array.isArray(order.meta.tickets)) {
    order.meta.tickets = order.meta.tickets.map(t => ({ ...t, status: 'void' }));
  }
  order.markModified('meta');
  return order;
}

export function summarize({ soft, hard, skipped, miss, revoked, released }) {
  console.log(`\n✅ Annulées: ${soft} | Supprimées: ${hard} | Payées ignorées: ${skipped}`
    + ` | Manquantes: ${miss} | Billets révoqués: ${revoked} | Places libérées: ${released}`);
}
