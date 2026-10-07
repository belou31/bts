#!/usr/bin/env node
// scripts/diagnostics/audit-large-orders.js
//
// Qui dépasserait le plafond ORDER_MAX_ITEMS ? À passer sur une base AVANT de
// déployer un plafond, car il ne s'applique pas qu'aux achats à venir :
//
//   — une commande existante de plus de N places reste valable, mais elle ne
//     serait plus reproductible en libre-service ;
//   — un abonné dont le renouvellement porte plus de N sièges serait refusé au
//     renouvellement, avec un message l'invitant à nous contacter ;
//   — un bon au solde supérieur à N ne pourrait plus être retiré d'un coup.
//
// Lecture seule : rien n'est modifié.
//
// Usage :
//   node scripts/diagnostics/audit-large-orders.js [--max=19]
import 'dotenv/config';
import process from 'node:process';
import mongoose from 'mongoose';

import { connectDB } from '../../src/loaders/mongoose.js';
import { orderMaxItems } from '../../src/config/order-limits.js';

function arg(name) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const max = Number(arg('max') ?? orderMaxItems());
  if (!Number.isInteger(max) || max <= 0) {
    console.log('Aucun plafond à vérifier (max =', max, ').');
    return;
  }
  await connectDB();
  const db = mongoose.connection.db;
  console.log(`Base : ${db.databaseName} — plafond examiné : ${max} places\n`);

  const orders = await db.collection('orders').aggregate([
    { $project: {
      n: { $sum: { $map: { input: { $ifNull: ['$lines', []] }, as: 'l',
            in: { $ifNull: ['$$l.qty', { $ifNull: ['$$l.quantity', 1] }] } } } },
      payerEmail: 1, status: 1, flow: '$origin.flow', saison: { $eq: ['$eventId', null] }
    } },
    { $match: { n: { $gt: max } } },
    { $sort: { n: -1 } }
  ]).toArray();

  console.log(`Commandes de plus de ${max} places : ${orders.length}`);
  for (const o of orders.slice(0, 20)) {
    console.log(`  ${String(o.n).padStart(4)} places | ${o.saison ? 'saison' : 'match '} `
      + `| ${String(o.flow || '?').padEnd(13)} | ${o.status} | ${o.payerEmail || '(sans email)'}`);
  }
  if (orders.length > 20) console.log(`  … et ${orders.length - 20} autres`);

  // Droits de renouvellement : nombre de sièges provisionnés par abonné, hors
  // match. C'est ce nombre que le plafond bornerait à la saison prochaine.
  const renewers = await db.collection('seats').aggregate([
    { $match: { status: { $in: ['provisioned', 'booked'] } } },
    { $group: { _id: { saison: '$seasonCode', venue: '$venueSlug', email: '$holderEmail' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: max }, '_id.email': { $nin: [null, ''] } } },
    { $sort: { n: -1 } }
  ]).toArray();

  console.log(`\nAbonnés détenant plus de ${max} sièges : ${renewers.length}`);
  for (const r of renewers.slice(0, 20)) {
    console.log(`  ${String(r.n).padStart(4)} sièges | ${r._id.saison} / ${r._id.venue} | ${r._id.email}`);
  }
  if (renewers.length > 20) console.log(`  … et ${renewers.length - 20} autres`);

  // Le solde restant est un virtuel du modèle (balance.total - balance.used) :
  // il n'existe pas en base, il faut le calculer ici.
  const vouchersBig = await db.collection('vouchers').aggregate([
    { $project: {
      code: 1,
      reste: { $subtract: [
        { $ifNull: ['$balance.total', 0] },
        { $ifNull: ['$balance.used', 0] }
      ] }
    } },
    { $match: { reste: { $gt: max } } },
    { $sort: { reste: -1 } }
  ]).toArray();

  console.log(`\nBons au solde supérieur à ${max} places : ${vouchersBig.length}`);
  for (const v of vouchersBig.slice(0, 20)) {
    console.log(`  ${String(v.reste).padStart(4)} places | ${v.code || v._id}`);
  }

  console.log(
    (orders.length || renewers.length || vouchersBig.length)
      ? '\n⚠ Au moins un cas dépasse le plafond : à traiter avant de le déployer.'
      : '\n✓ Aucun cas existant ne dépasse le plafond.'
  );
}

main()
  .catch(err => { console.error('[audit-large-orders]', err?.message || err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
