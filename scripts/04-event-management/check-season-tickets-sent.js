#!/usr/bin/env node
/**
 * Qui a reçu ses billets pour ce match, et qui n'a rien reçu.
 *
 * « Send All Season Tickets for Event » affiche des totaux ; ce script nomme
 * les manquants et dit pourquoi, ce qui est la seule façon de vérifier qu'un
 * envoi est complet.
 *
 * Les commandes examinées sont celles produites par la synchronisation
 * (Sync Season Orders to Event) : une par abonnement, rattachée au match.
 * Un abonné présent à la synchronisation mais absent d'ici n'a pas de
 * commande de match — c'est la synchronisation qu'il faut rejouer, pas l'envoi.
 *
 * Lecture seule.
 *
 * Usage:
 *   node scripts/04-event-management/check-season-tickets-sent.js --event=<slug|id> [--missing]
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { Order, Event } from '../../src/models/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const arg = (name) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || null;
const hasFlag = (name) => process.argv.includes(`--${name}`);

// Pourquoi cette commande n'a pas (ou pas vraiment) reçu ses billets.
function classify(order) {
  const st = order.meta?.seasonTickets || null;
  const status = String(order.status || '').toLowerCase();

  if (status === 'torelocate') {
    return order.paymentProviderMeta?.seatPendingNoticeSentAt
      ? { state: 'relogement-notifié', ok: true, why: 'sans place : invitation à choisir une place envoyée' }
      : { state: 'relogement-à-notifier', ok: false, why: 'sans place pour ce match et AUCUN message envoyé' };
  }
  if (!st?.lastSentAt) {
    return { state: 'jamais-envoyé', ok: false, why: 'aucune trace d\'envoi' };
  }
  if (st.lastSentMode === 'dry-run') {
    // Le cas qui trompe : la commande paraît traitée, personne n'a rien reçu.
    return { state: 'simulation-seulement', ok: false,
      why: `marquée par un dry-run le ${new Date(st.lastSentAt).toISOString().slice(0, 16)} — aucun courriel parti` };
  }
  return { state: 'envoyé', ok: true, why: new Date(st.lastSentAt).toISOString().slice(0, 16) };
}

async function main() {
  const ref = arg('event');
  if (!ref) {
    console.error('Usage: node scripts/04-event-management/check-season-tickets-sent.js --event=<slug|id> [--missing]');
    process.exit(1);
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  await mongoose.connect(uri);

  const ev = /^[0-9a-f]{24}$/i.test(ref)
    ? await Event.findById(ref).lean()
    : await Event.findOne({ slug: ref }).lean();
  if (!ev) throw new Error(`Événement introuvable : ${ref}`);

  // Même sélection que le script d'envoi : uniquement les commandes issues de
  // la synchronisation. Les billets achetés directement pour ce match ont été
  // envoyés à l'achat et ne relèvent pas de cet envoi — les compter ici
  // faisait passer des acheteurs servis pour des abonnés oubliés.
  const orders = await Order.find({
    status: { $in: ['paid', 'torelocate'] },
    payerEmail: { $ne: null },
    $and: [
      { $or: [{ eventId: ev._id }, { 'meta.eventId': String(ev._id) }] },
      { $or: [
        { parentOrderId: { $ne: null } },
        { 'paymentProviderMeta.seasonOrderId': { $exists: true, $ne: null } }
      ] }
    ]
  }).sort({ createdAt: 1 }).lean();

  // Comptées à part, pour que leur absence du rapport ne surprenne pas.
  const directCount = await Order.countDocuments({
    status: { $in: ['paid', 'torelocate'] },
    $and: [
      { $or: [{ eventId: ev._id }, { 'meta.eventId': String(ev._id) }] },
      { parentOrderId: null },
      { 'paymentProviderMeta.seasonOrderId': { $exists: false } }
    ]
  });

  console.log(`\n${ev.slug} — ${orders.length} commande(s) issue(s) d'un abonnement`);
  if (directCount) {
    console.log(`  (${directCount} achat(s) direct(s) de ce match, hors périmètre :`
      + ' leurs billets sont partis à l\'achat)');
  }
  if (!orders.length) {
    console.log('  Aucune : lancer d\'abord « Sync Season Orders to Event ».');
    await mongoose.disconnect();
    return;
  }

  const rows = orders.map(o => ({ order: o, ...classify(o) }));
  const byState = new Map();
  for (const r of rows) byState.set(r.state, (byState.get(r.state) || 0) + 1);

  console.log('\n=== Récapitulatif ===');
  for (const [state, n] of [...byState.entries()].sort((a, b) => b[1] - a[1])) {
    const ok = rows.find(r => r.state === state)?.ok;
    console.log(`  ${ok ? '✔' : '⚠'} ${state.padEnd(24)} ${n}`);
  }

  const missing = rows.filter(r => !r.ok);
  if (!missing.length) {
    console.log('\n✔ Envoi complet : chaque abonné rattaché à ce match a été servi.');
  } else {
    console.log(`\n⚠ ${missing.length} abonné(s) n'ont rien reçu :`);
    for (const r of (hasFlag('missing') ? missing : missing.slice(0, 20))) {
      console.log(`  ${r.order._id}  ${String(r.order.payerEmail || '—').padEnd(32)} ${r.why}`);
    }
    if (!hasFlag('missing') && missing.length > 20) {
      console.log(`  … ${missing.length - 20} de plus (--missing pour tout lister)`);
    }
    console.log('\n  Relancer l\'envoi les servira : les commandes déjà servies restent ignorées.');
    console.log(`    node scripts/04-event-management/send-all-season-tickets-for-event.js --event=${ev.slug}`);
  }

  // Un abonnement payé sans commande de match relève de la synchronisation,
  // pas de l'envoi : le distinguer évite de relancer le mauvais script.
  const childParents = new Set(rows.map(r => String(r.order.parentOrderId || '')).filter(Boolean));
  const seasonPaid = await Order.find({
    seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, status: 'paid',
    'origin.flow': { $in: ['subscription', 'renew'] }
  }, { payerEmail: 1 }).lean();
  const notSynced = seasonPaid.filter(o => !childParents.has(String(o._id)));
  if (notSynced.length) {
    console.log(`\n⚠ ${notSynced.length} abonnement(s) payé(s) SANS commande pour ce match :`);
    for (const o of notSynced.slice(0, 10)) console.log(`  ${o._id}  ${o.payerEmail || '—'}`);
    if (notSynced.length > 10) console.log(`  … ${notSynced.length - 10} de plus`);
    console.log('  Ceux-là ne relèvent pas de l\'envoi mais de la synchronisation :');
    console.log(`    node scripts/04-event-management/sync-season-orders-to-event.js --event=${ev.slug} --commit`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err.message || err);
  try { await mongoose.disconnect(); } catch { /* rien de mieux à faire */ }
  process.exit(1);
});
