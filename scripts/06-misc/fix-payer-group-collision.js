#!/usr/bin/env node
/**
 * Débloque une commande refusée par l'index uniq_paid_per_payer.
 *
 * L'index est unique sur (seasonCode, venueSlug, groupKey, payerEmail) et ne
 * porte que sur les commandes `paid`. Il visait « un seul paiement abouti par
 * groupe » ; avec l'ancien groupKey constant par saison (`SUBSCRIPTION-<code>`,
 * `RENEW-<code>`) il signifiait en fait « un seul paiement par personne et par
 * saison » — et rejetait la deuxième commande légitime d'un même acheteur,
 * APRÈS réservation des sièges.
 *
 * subscription.js et renew.js génèrent désormais un groupKey unique par
 * commande (suffixe ObjectId). Restent les commandes créées avant ce
 * changement : ce script leur en attribue un, ce qui lève le blocage sans
 * toucher à l'index ni aux sièges.
 *
 * Ne modifie QUE groupKey. Ni statut, ni sièges, ni montant, ni e-mail.
 *
 * Usage:
 *   # 1. voir les collisions d'une saison (lecture seule)
 *   node scripts/06-misc/fix-payer-group-collision.js --season=2026-2027
 *
 *   # 2. débloquer une commande précise
 *   node scripts/06-misc/fix-payer-group-collision.js --order=<id> [--commit]
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { Order } from '../../src/models/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const arg = (name) => {
  const p = process.argv.find(a => a.startsWith(`--${name}=`));
  return p ? p.split('=').slice(1).join('=') : null;
};
const hasFlag = name => process.argv.includes(`--${name}`);

// Conserve le préfixe lisible et ajoute l'identifiant qui rend la clé unique —
// même forme que celle produite aujourd'hui par subscription.js / renew.js.
function freshGroupKey(order) {
  const current = String(order.groupKey || '').trim();
  const prefix = current || `${String(order.origin?.flow || 'ORDER').toUpperCase()}-${order.seasonCode || ''}`;
  return `${prefix}-${new mongoose.Types.ObjectId().toString()}`;
}

async function report(seasonCode) {
  const rows = await Order.aggregate([
    { $match: { seasonCode, payerEmail: { $nin: [null, ''] } } },
    { $group: {
      _id: { venueSlug: '$venueSlug', groupKey: '$groupKey', payerEmail: '$payerEmail' },
      total: { $sum: 1 },
      paid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
      orders: { $push: { id: '$_id', status: '$status', flow: '$origin.flow', totalCents: '$totalCents' } }
    } },
    { $match: { total: { $gt: 1 } } },
    { $sort: { paid: -1 } }
  ]);

  if (!rows.length) {
    console.log(`\nAucun groupKey partagé pour ${seasonCode}. L'index ne peut bloquer personne ici.`);
    return;
  }

  console.log(`\n${rows.length} groupKey partagé(s) par plusieurs commandes — ${seasonCode}\n`);
  for (const r of rows) {
    // Deux `paid` déjà en base seraient impossibles : c'est bien la SECONDE
    // qui est refusée. Un seul `paid` + d'autres en attente = blocage à venir.
    const risk = r.paid >= 1 && r.total > r.paid;
    console.log(`  ${r._id.payerEmail}  (${r._id.venueSlug})`);
    console.log(`    groupKey : ${r._id.groupKey}`);
    for (const o of r.orders) {
      console.log(`      ${o.id}  ${String(o.status).padEnd(10)} ${String(o.flow || '').padEnd(13)} ${(o.totalCents || 0) / 100} €`);
    }
    if (risk) {
      const blocked = r.orders.filter(o => o.status !== 'paid');
      console.log(`    ⚠ ${blocked.length} commande(s) ne pourront pas être finalisées tant que le groupKey est partagé.`);
      for (const b of blocked) {
        console.log(`      → node scripts/06-misc/fix-payer-group-collision.js --order=${b.id} --commit`);
      }
    }
    console.log('');
  }
}

async function fixOne(orderId, commit) {
  if (!mongoose.Types.ObjectId.isValid(orderId)) throw new Error(`Identifiant invalide : ${orderId}`);
  const order = await Order.findById(orderId);
  if (!order) throw new Error(`Commande introuvable : ${orderId}`);

  console.log(`\nCommande ${order._id}`);
  console.log(`  statut   : ${order.status}`);
  console.log(`  flux     : ${order.origin?.flow || '—'} | ${order.seasonCode} / ${order.venueSlug}`);
  console.log(`  payeur   : ${order.payerEmail || '—'}`);
  console.log(`  groupKey : ${order.groupKey || '(vide)'}`);

  const siblings = await Order.find({
    _id: { $ne: order._id },
    seasonCode: order.seasonCode,
    venueSlug: order.venueSlug,
    groupKey: order.groupKey,
    payerEmail: order.payerEmail
  }, { status: 1, totalCents: 1 }).lean();

  if (!siblings.length) {
    console.log('\n  Aucune autre commande ne partage ce groupKey : l\'index ne bloque pas cette commande.');
    console.log('  Si elle reste bloquée, la cause est ailleurs (voir check-order-payment.js).');
    return;
  }

  console.log(`\n  ${siblings.length} autre(s) commande(s) sur le même groupKey :`);
  for (const s of siblings) console.log(`    ${s._id}  ${s.status}  ${(s.totalCents || 0) / 100} €`);
  const paidSiblings = siblings.filter(s => s.status === 'paid').length;
  if (!paidSiblings) {
    console.log('\n  Aucune n\'est encore `paid` : la collision se produira à la première finalisation.');
  }

  const next = freshGroupKey(order);
  console.log(`\n  groupKey : ${order.groupKey || '(vide)'}`);
  console.log(`           → ${next}`);

  if (!commit) {
    console.log('\n  Simulation. Relancer avec --commit pour écrire.');
    return;
  }

  const previous = order.groupKey || '';
  order.groupKey = next;
  order.adminEdits = [...(order.adminEdits || []), {
    at: new Date(),
    by: 'fix-payer-group-collision',
    kind: 'group-key',
    changes: [`groupKey ${previous || '(vide)'} → ${next}`]
  }];
  order.markModified('adminEdits');
  await order.save();

  console.log('\n  ✔ groupKey réattribué. Rien d\'autre n\'a été modifié.');
  if (order.status !== 'paid') {
    console.log(`  Finaliser ensuite si le paiement est abouti :`);
    console.log(`    node scripts/06-misc/check-order-payment.js --order=${order._id} --commit`);
  }
}

async function main() {
  const seasonCode = arg('season');
  const orderId = arg('order');
  if (!seasonCode && !orderId) {
    console.error('Usage: --season=<code> (rapport) ou --order=<id> [--commit]');
    process.exit(1);
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  await mongoose.connect(uri);

  if (orderId) await fixOne(orderId, hasFlag('commit'));
  else await report(seasonCode);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
