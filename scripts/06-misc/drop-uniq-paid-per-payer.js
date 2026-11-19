#!/usr/bin/env node
/**
 * Retire l'index `uniq_paid_per_payer` de la collection `orders`.
 *
 * POURQUOI
 * L'index était unique sur (seasonCode, venueSlug, groupKey, payerEmail) parmi
 * les seules commandes `paid`. Il visait le double paiement, mais ne
 * l'exprimait pas : avec le groupKey constant par saison de l'époque
 * (`SUBSCRIPTION-<code>`, `RENEW-<code>`), il signifiait « un seul paiement
 * abouti par personne et par saison » et refusait la deuxième commande
 * légitime d'un même acheteur — après réservation des sièges.
 *
 * subscription.js et renew.js émettent désormais un groupKey unique par
 * commande : l'index ne peut donc plus déclencher que sur des commandes
 * héritées, c'est-à-dire uniquement sur des faux positifs.
 *
 * CE QUI PROTÈGE VRAIMENT DU DOUBLE PAIEMENT
 * Rien n'est perdu, parce que la garantie n'a jamais reposé sur cet index :
 *   1. `Seat` porte l'index unique `uniq_seat_per_season_venue`
 *      (seasonCode, venueSlug, seatId) : un seul document par place ;
 *   2. finalizePaidIfNoConflict fait passer les places à `booked` par un
 *      updateMany conditionnel — une place déjà `booked` ne satisfait plus le
 *      filtre, le compte ne correspond pas, la commande bascule en `failed`.
 * C'est atomique, et cela porte sur la PLACE plutôt que sur le PAYEUR.
 *
 * Ce script REFUSE de retirer l'index si (1) est absent : ce serait démonter
 * un garde-fou pendant que le vrai manque (cas d'une base restaurée sans
 * index — l'application ne les crée pas hors développement).
 *
 * Aucun remplaçant côté commande : un index unique sur `lines.seatId` n'est
 * pas praticable, les lignes ZONE ayant un seatId virtuel vide ou partagé.
 *
 * Usage:
 *   node scripts/06-misc/drop-uniq-paid-per-payer.js            # état des lieux
 *   node scripts/06-misc/drop-uniq-paid-per-payer.js --commit   # retire l'index
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const INDEX_NAME = 'uniq_paid_per_payer';
const SEAT_GUARD = 'uniq_seat_per_season_venue';
const hasFlag = name => process.argv.includes(`--${name}`);

async function main() {
  const commit = hasFlag('commit');
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const orders = db.collection('orders');
  const seats = db.collection('seats');

  const orderIdx = await orders.indexes();
  const target = orderIdx.find(i => i.name === INDEX_NAME);

  console.log(`\nBase : ${mongoose.connection.name}`);
  console.log(`\n=== ${INDEX_NAME} ===`);
  if (!target) {
    console.log('  absent — rien à faire.');
  } else {
    console.log(`  présent : ${JSON.stringify(target.key)}`);
    console.log(`  unique  : ${target.unique} · partiel : ${JSON.stringify(target.partialFilterExpression)}`);
  }

  // Garde-fou : ne jamais retirer celui-ci si le vrai n'est pas en place.
  const seatIdx = await seats.indexes();
  const guard = seatIdx.find(i => i.name === SEAT_GUARD);
  console.log(`\n=== Protection réelle (collection seats) ===`);
  if (guard?.unique) {
    console.log(`  ✔ ${SEAT_GUARD} ${JSON.stringify(guard.key)} · UNIQUE`);
  } else {
    console.log(`  ✘ ${SEAT_GUARD} absent ou non unique`);
  }

  // Ce que l'index bloquait encore : les groupKey hérités, partagés.
  const shared = await orders.aggregate([
    { $match: { payerEmail: { $nin: [null, ''] }, groupKey: { $nin: [null, ''] } } },
    { $group: {
      _id: { s: '$seasonCode', v: '$venueSlug', g: '$groupKey', e: '$payerEmail' },
      total: { $sum: 1 },
      paid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } }
    } },
    { $match: { total: { $gt: 1 } } }
  ]).toArray();
  const blocked = shared.filter(r => r.paid >= 1 && r.total > r.paid);
  console.log(`\n=== Faux positifs restants ===`);
  console.log(`  groupKey partagés : ${shared.length}`);
  console.log(`  dont bloquant une commande non finalisée : ${blocked.length}`);
  if (blocked.length) {
    console.log('  (le retrait de l\'index les débloque tous d\'un coup)');
  }

  if (!guard?.unique) {
    console.error(`\n❌ Retrait refusé : ${SEAT_GUARD} n'est pas en place sur \`seats\`.`);
    console.error('   Retirer cet index maintenant laisserait le double paiement sans aucune garde.');
    console.error('   Recréer d\'abord les index (00-system-management), puis relancer.');
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  if (!target) { await mongoose.disconnect(); return; }

  if (!commit) {
    console.log(`\nSimulation. Relancer avec --commit pour retirer ${INDEX_NAME}.`);
    await mongoose.disconnect();
    return;
  }

  await orders.dropIndex(INDEX_NAME);
  const after = (await orders.indexes()).some(i => i.name === INDEX_NAME);
  console.log(`\n✔ ${INDEX_NAME} retiré. Encore présent : ${after}`);
  console.log('  La protection contre le double paiement reste assurée par');
  console.log(`  ${SEAT_GUARD} et l'updateMany conditionnel de finalizePaidIfNoConflict.`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
