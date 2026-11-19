#!/usr/bin/env node
/**
 * Compte les commandes `failed` par cause, pour mesurer avant de corriger.
 *
 * Le tri qui compte est la PHASE, pas la cause :
 *   pre_payment  — rien n'a été encaissé, le client n'a qu'à recommencer.
 *                  C'est du bruit : à surveiller en tendance, pas à traiter.
 *   post_payment — le paiement est passé et la commande n'existe pas. Le client
 *                  a payé sans place. Chacune de ces lignes demande un geste :
 *                  remboursement ou relogement.
 *
 * Lecture seule.
 *
 * Usage:
 *   node scripts/06-misc/reports/failed-orders.js [--season=<code>] [--since=YYYY-MM-DD] [--details]
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { Order } from '../../../src/models/index.js';
import { PRE_PAYMENT, POST_PAYMENT } from '../../../src/utils/order-failure.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const arg = (name) => {
  const p = process.argv.find(a => a.startsWith(`--${name}=`));
  return p ? p.split('=').slice(1).join('=') : null;
};
const hasFlag = name => process.argv.includes(`--${name}`);

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  await mongoose.connect(uri);

  const match = { status: 'failed' };
  const season = arg('season');
  if (season) match.seasonCode = season;
  const since = arg('since');
  if (since) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) throw new Error(`--since invalide : ${since}`);
    match.createdAt = { $gte: d };
  }

  const total = await Order.countDocuments(match);
  console.log(`\n${total} commande(s) « failed »`
    + `${season ? ` — ${season}` : ''}${since ? ` — depuis ${since}` : ''}`);
  if (!total) { await mongoose.disconnect(); return; }

  // Les commandes antérieures à la traçabilité n'ont pas failureReason, mais
  // portent souvent l'ancien champ : `conflict.kind` (posé après paiement) ou
  // `reason` (posé avant). On les relit ici plutôt que de migrer la base —
  // l'historique reste lisible sans réécrire quoi que ce soit.
  const resolvedReason = {
    $ifNull: ['$paymentProviderMeta.failureReason',
      { $ifNull: ['$paymentProviderMeta.conflict.kind', '$paymentProviderMeta.reason'] }]
  };
  const resolvedPhase = {
    $ifNull: ['$paymentProviderMeta.failurePhase',
      { $cond: [{ $ifNull: ['$paymentProviderMeta.conflict.kind', false] }, POST_PAYMENT,
        { $cond: [{ $ifNull: ['$paymentProviderMeta.reason', false] }, PRE_PAYMENT, null] }] }]
  };

  const rows = await Order.aggregate([
    { $match: match },
    { $addFields: { _reason: resolvedReason, _phase: resolvedPhase } },
    { $group: {
      _id: { phase: '$_phase', reason: '$_reason' },
      n: { $sum: 1 },
      cents: { $sum: '$totalCents' },
      last: { $max: '$createdAt' },
      inferred: { $sum: { $cond: [{ $ifNull: ['$paymentProviderMeta.failureReason', false] }, 0, 1] } }
    } },
    { $sort: { n: -1 } }
  ]);

  for (const phase of [POST_PAYMENT, PRE_PAYMENT, null]) {
    const group = rows.filter(r => (r._id.phase || null) === phase);
    if (!group.length) continue;
    const label = phase === POST_PAYMENT
      ? 'APRÈS PAIEMENT — le client a payé sans obtenir sa place'
      : phase === PRE_PAYMENT
        ? 'avant paiement — rien encaissé, sans gravité'
        : 'sans cause enregistrée — commandes antérieures à la traçabilité';
    console.log(`\n=== ${label} ===`);
    for (const r of group) {
      console.log(`  ${String(r._id.reason || '(aucune)').padEnd(24)} ${String(r.n).padStart(4)}`
        + `   ${(r.cents / 100).toFixed(2)} €   dernière : ${r.last ? new Date(r.last).toISOString().slice(0, 10) : '—'}`
        + `${r.inferred ? `   (${r.inferred} déduite(s) d'un champ historique)` : ''}`);
    }
    const sum = group.reduce((s, r) => s + r.n, 0);
    if (phase === POST_PAYMENT) {
      console.log(`  → ${sum} commande(s) à instruire (remboursement ou relogement).`);
    }
  }

  if (hasFlag('details')) {
    // Même déduction que le résumé : filtrer sur le seul champ neuf laisserait
    // les commandes historiques hors de la liste tout en les comptant plus haut.
    const docs = await Order.aggregate([
      { $match: match },
      { $addFields: { _reason: resolvedReason, _phase: resolvedPhase } },
      { $match: { _phase: POST_PAYMENT } },
      { $sort: { createdAt: -1 } },
      { $limit: 50 },
      { $project: { payerEmail: 1, totalCents: 1, createdAt: 1, seasonCode: 1, paymentProviderMeta: 1, _reason: 1 } }
    ]);
    if (docs.length) {
      console.log(`\n=== Détail des échecs après paiement (${docs.length}) ===`);
      for (const d of docs) {
        console.log(`  ${d._id}  ${new Date(d.createdAt).toISOString().slice(0, 10)}`
          + `  ${String(d.payerEmail || '—').padEnd(30)} ${(d.totalCents / 100).toFixed(2)} €`);
        console.log(`      ${d._reason || '—'}`
          + `${d.paymentProviderMeta?.conflict?.detail ? ' — ' + String(d.paymentProviderMeta.conflict.detail).slice(0, 90) : ''}`);
      }
      console.log('\n  Vérifier chacune au tableau de bord du prestataire :');
      console.log('    node scripts/06-misc/check-order-payment.js --order=<id>');
    }
  } else {
    console.log('\n(--details pour lister les commandes à instruire)');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
