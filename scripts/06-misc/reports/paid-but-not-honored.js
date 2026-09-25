#!/usr/bin/env node
/**
 * Commandes PAYÉES que le système n'a pas honorées.
 *
 * Le cas le plus coûteux de la billetterie : le client a payé, et sa commande
 * est `canceled` ou `failed`. Il n'a ni place ni billet, et rien ne le signale
 * — ces commandes se confondent avec les abandons ordinaires, qui sont
 * nombreux et sans conséquence.
 *
 * Une commande est retenue ici dès qu'UNE trace de paiement abouti subsiste :
 *   - le prestataire a répondu « payé » (API, webhook ou page de retour) ;
 *   - le code de retour vaut `succeeded` ;
 *   - une finalisation a réussi auparavant ;
 *   - au moins une échéance a été encaissée (paiement fractionné).
 *
 * Chacune demande une décision humaine — réanimer, reloger ou rembourser — et
 * la commande à lancer est affichée avec la ligne.
 *
 * Lecture seule.
 *
 * Usage:
 *   node scripts/06-misc/reports/paid-but-not-honored.js [--event=<slug|id>] [--season=<code>] [--since=AAAA-MM-JJ] [--all]
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { Order, Event } from '../../../src/models/index.js';
import { isPaidLike } from '../../../src/services/order-finalization.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const arg = (n) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') || null;
const hasFlag = (n) => process.argv.includes(`--${n}`);

const UNHONORED = ['canceled', 'failed'];

/**
 * Les preuves de paiement, de la plus fiable à la plus faible. On les rend
 * toutes : lorsqu'elles se contredisent, c'est l'écart lui-même qui renseigne.
 */
function paymentEvidence(order) {
  const m = order.paymentProviderMeta || {};
  const found = [];
  if (isPaidLike(m.lastStatusFromApi)) found.push(`API=${m.lastStatusFromApi}`);
  if (isPaidLike(m.lastWebhookStatus)) found.push(`webhook=${m.lastWebhookStatus}`);
  if (isPaidLike(m.lastStatusFromReturn)) found.push(`retour=${m.lastStatusFromReturn}`);
  if (isPaidLike(m.lastReturnProviderStatus)) found.push(`retour=${m.lastReturnProviderStatus}`);
  if (String(m.lastReturnCode || '').toLowerCase() === 'succeeded') found.push('lastReturnCode=succeeded');
  if (m.lastSuccessfulFinalizeAt) found.push(`finalisée le ${new Date(m.lastSuccessfulFinalizeAt).toISOString().slice(0, 16)}`);
  const paidCount = Number(m.installments?.paidCount || 0);
  if (paidCount > 0) found.push(`${paidCount} échéance(s) encaissée(s)`);
  // lastStatusFromReturn et lastReturnProviderStatus portent le plus souvent
  // la même valeur : l'afficher deux fois laisse croire à deux preuves.
  return Array.from(new Set(found));
}

/** Pourquoi la commande n'a pas été honorée, si la trace le dit. */
function whyUnhonored(order) {
  const m = order.paymentProviderMeta || {};
  if (m.failureReason) return `${m.failureReason} (${m.failurePhase || '—'})`;
  if (m.conflict?.kind) return m.conflict.kind;
  if (m.reason) return m.reason;
  if (order.status === 'canceled' && m.revivedFromCanceled) return 'annulée puis réanimée';
  if (order.status === 'canceled') return 'annulée — délai dépassé (sentinelle, PENDING_MAX_MIN)';
  return '—';
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);

  const match = { status: { $in: UNHONORED } };

  const eventRef = arg('event');
  let ev = null;
  if (eventRef) {
    ev = /^[0-9a-f]{24}$/i.test(eventRef)
      ? await Event.findById(eventRef).lean()
      : await Event.findOne({ slug: eventRef }).lean();
    if (!ev) throw new Error(`Événement introuvable : ${eventRef}`);
    match.$or = [
      { eventId: ev._id },
      { 'meta.eventId': String(ev._id) },
      ...(ev.slug ? [{ 'meta.eventSlug': ev.slug }] : [])
    ];
  }
  const season = arg('season');
  if (season) match.seasonCode = season;
  const since = arg('since');
  if (since) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) throw new Error(`--since invalide : ${since}`);
    match.createdAt = { $gte: d };
  }

  const orders = await Order.find(match).sort({ createdAt: -1 }).lean();
  const flagged = orders
    .map((o) => ({ order: o, evidence: paymentEvidence(o) }))
    .filter((r) => r.evidence.length);

  const scope = [ev ? ev.slug : null, season, since ? `depuis ${since}` : null].filter(Boolean).join(' · ') || 'toutes saisons';
  console.log(`\n${scope}`);
  console.log(`  commandes canceled/failed examinées : ${orders.length}`);
  console.log(`  dont portant une trace de paiement  : ${flagged.length}`);

  if (!flagged.length) {
    console.log('\n✔ Aucune commande payée laissée sans suite.');
    await mongoose.disconnect();
    return;
  }

  const euros = flagged.reduce((s, r) => s + Number(r.order.totalCents || 0), 0) / 100;
  console.log(`  montant concerné                    : ${euros.toFixed(2)} €`);
  console.log('\n⚠ À instruire — le client a payé et n\'a rien reçu :\n');

  for (const { order, evidence } of flagged) {
    const seats = (order.lines || []).map(l => l.seatId || l.zoneKey).filter(Boolean).join(', ') || '—';
    console.log(`  ${order._id}  ${String(order.status).padEnd(9)} ${(Number(order.totalCents || 0) / 100).toFixed(2)} €`);
    console.log(`     ${new Date(order.createdAt).toISOString().slice(0, 16)}  ${order.payerEmail || '—'}  [${seats}]`);
    console.log(`     preuve(s) : ${evidence.join(' · ')}`);
    console.log(`     motif     : ${whyUnhonored(order)}`);
    console.log(`     → node scripts/06-misc/check-order-payment.js --order=${order._id} --canceled --commit`);
    console.log('');
  }

  console.log('  Si le prestataire ne répond plus pour une commande ancienne, ajouter --force');
  console.log('  après avoir vérifié le paiement au tableau de bord.');

  if (!hasFlag('all') && !eventRef && !season) {
    console.log('\n  (périmètre : toute la base — restreindre avec --event= ou --season=)');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err.message || err);
  try { await mongoose.disconnect(); } catch { /* rien de mieux à faire */ }
  process.exit(1);
});
