#!/usr/bin/env node
/**
 * Renvoie le courriel de confirmation d'UNE commande, quel que soit son flux.
 *
 * `04-event-management/resend-event-tickets.js` exige --event : il ne sait donc
 * rien renvoyer pour un abonnement ni pour un renouvellement, qui ne sont
 * rattachés à aucun match. C'est précisément le cas où l'on a besoin de
 * renvoyer à la main — d'où ce script, qui ne prend qu'un identifiant de
 * commande.
 *
 * Sert aussi à diagnostiquer : sans --commit, il affiche l'état d'envoi de la
 * commande et la raison probable du non-envoi, sans rien expédier.
 *
 * Usage:
 *   node scripts/06-misc/resend-order-email.js --order=<id>            # diagnostic
 *   node scripts/06-misc/resend-order-email.js --order=<id> --commit   # envoi
 *   node scripts/06-misc/resend-order-email.js --order=<id> --commit --force
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 *   - EMAIL_STUB=true écrit dans data/outputs/outbox/ au lieu d'expédier.
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import dotenv from 'dotenv';
dotenv.config();

import { Order } from '../../src/models/Order.js';
import { sendOrderAttestationIfNeeded } from '../../src/services/order-finalization.js';
import { renderOrderEmail, subjectForOrder } from '../../src/services/mailer.js';

const argv = yargs(hideBin(process.argv))
  .option('order', { type: 'string', demandOption: true, desc: 'Identifiant de la commande' })
  .option('commit', { type: 'boolean', default: false, desc: 'Envoie réellement (sinon diagnostic seul)' })
  .option('force', { type: 'boolean', default: false, desc: 'Renvoie même si déjà envoyé' })
  .help().argv;

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  const opts = {};
  if (process.env.MONGODB_DB) opts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, opts);

  const order = await Order.findById(String(argv.order).trim());
  if (!order) throw new Error(`Commande introuvable : ${argv.order}`);

  const meta = order.paymentProviderMeta || {};
  const stub = String(process.env.EMAIL_STUB || 'false').toLowerCase() === 'true';

  console.log(`Commande ${order._id}`);
  console.log(`  statut          : ${order.status}`);
  console.log(`  flux            : ${order.origin?.flow || '—'} | gabarit : ${order.mailTemplateKind || '—'}`);
  console.log(`  destinataire    : ${order.payerEmail || '⚠ AUCUN'}`);
  console.log(`  déjà envoyé le  : ${meta.attestationSentAt || 'jamais'}`);
  if (meta.attestationSendingAt) {
    console.log(`  ⚠ envoi en cours depuis ${meta.attestationSendingAt} (verrou) — un envoi précédent a pu être interrompu.`);
  }
  console.log(`  mode courriel   : ${stub ? 'EMAIL_STUB (écriture dans data/outputs/outbox/)' : 'SMTP réel'}`);

  // Ce qui bloque le plus souvent, dans l'ordre où on le rencontre.
  if (!order.payerEmail) {
    console.log('\n❌ Aucune adresse sur la commande : rien ne peut partir.');
  }
  if (meta.attestationSentAt && !argv.force) {
    console.log('\nℹ Déjà marquée comme envoyée : ajouter --force pour renvoyer.');
  }

  // Le rendu est la cause d'échec la plus fréquente, et la seule qu'on puisse
  // reproduire sans expédier quoi que ce soit.
  try {
    const subject = await subjectForOrder(order);
    const html = await renderOrderEmail(order);
    console.log(`\n✅ Rendu du courriel OK — sujet : « ${subject} » (${html.length} caractères)`);
  } catch (e) {
    console.log(`\n❌ Le rendu du courriel échoue : ${e.message}`);
    console.log('   C\'est la cause du non-envoi : sendOrderAttestationIfNeeded lève avant d\'expédier.');
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  if (!argv.commit) {
    console.log('\n🧪 Diagnostic seul — relancer avec --commit pour envoyer.');
    await mongoose.disconnect();
    return;
  }

  const sent = await sendOrderAttestationIfNeeded(order, { force: argv.force, source: 'resend-order-email' });
  console.log(sent
    ? `\n✅ Courriel envoyé à ${order.payerEmail}.`
    : '\nℹ Rien envoyé (déjà expédié, ou envoi concurrent en cours). Ajouter --force si besoin.');

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
