#!/usr/bin/env node
/**
 * Confronte l'état d'une commande à ce que dit le prestataire de paiement.
 *
 * Une commande qui reste « pending » ne dit pas POURQUOI : le client a-t-il
 * abandonné, le prestataire n'a-t-il jamais confirmé, ou la vérification
 * échoue-t-elle (identifiants, réseau) sans que rien ne l'affiche ? Les échecs
 * de contrôle sont journalisés en stderr et passent facilement inaperçus.
 *
 * Ce script pose la question au prestataire et affiche sa réponse brute.
 * Avec --commit, il finalise la commande si — et seulement si — le prestataire
 * la déclare payée.
 *
 * Usage:
 *   node scripts/06-misc/check-order-payment.js --order=<id>
 *   node scripts/06-misc/check-order-payment.js --order=<id> --commit
 *   node scripts/06-misc/check-order-payment.js --pending [--season=<code>]
 *   node scripts/06-misc/check-order-payment.js --canceled --commit   # réanimation
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { loadEnv } from '../lib/load-env.js';

// `.env` PUIS `.env.<PAYMENT_PROVIDER>` : les identifiants du prestataire ne
// sont pas dans le premier. Voir scripts/lib/load-env.js.
const ENV = loadEnv();

import { Order } from '../../src/models/Order.js';
import {
  getCheckoutStatus,
  normalizeStatus,
  currentPaymentProviderId
} from '../../src/services/payments/index.js';
import { finalizePaidIfNoConflict, isPaidLike, sendOrderAttestationIfNeeded } from '../../src/services/order-finalization.js';

async function inspect(order, { commit, allowCanceled = false, force = false }) {
  const meta = order.paymentProviderMeta || {};
  const intentId = String(meta.checkoutIntentId || '').trim();

  console.log(`\nCommande ${order._id}`);
  console.log(`  statut local    : ${order.status}`);
  console.log(`  flux            : ${order.origin?.flow || '—'} | total : ${(order.totalCents / 100).toFixed(2)} €`);
  console.log(`  prestataire     : ${meta.name || order.paymentProvider || '—'}`);
  console.log(`  checkoutIntentId: ${intentId || '⚠ ABSENT — aucune vérification possible'}`);
  console.log(`  dernier contrôle: ${meta.lastStatusCheckedAt || 'jamais'}`);
  console.log(`  dernier retour  : ${meta.lastStatusFromReturn || '—'} | webhook : ${meta.lastWebhookEvent || '—'}`);

  if (!intentId) {
    console.log('  → Sans identifiant de checkout, ni le retour ni le polling ne peuvent confirmer.');
    return;
  }

  let raw;
  let providerFailed = false;
  try {
    raw = await getCheckoutStatus(intentId);
  } catch (e) {
    // C'est LE cas qui produit un « pending » éternel sans explication :
    // la vérification lève, l'appelant l'avale, la commande ne bouge plus.
    providerFailed = true;
    console.log(`  ❌ Le prestataire n'a pas répondu : ${e?.message || e}`);
    console.log('     Tant que cet appel échoue, la commande restera « pending ».');
    console.log('     Vérifier les identifiants : node scripts/00-system-management/check-payment-provider.js');
    // Sans --force on s'arrête là. AVEC, on continue : dépanner une commande
    // dont le paiement est vérifié au tableau de bord ne doit pas dépendre de
    // la joignabilité de l'API — c'est précisément quand elle ne répond pas
    // qu'on en a besoin.
    if (!force) return;
    console.log('     ⚠ --force : on poursuit malgré l\'absence de réponse.');
    raw = '';
  }

  const normalized = normalizeStatus(raw);
  if (!providerFailed) console.log(`  réponse brute   : ${JSON.stringify(raw)}`);
  console.log(`  → normalisé     : ${normalized}${isPaidLike(normalized) ? ' (payé)' : ''}`);

  if (!isPaidLike(normalized) && !force) {
    console.log('  → Le prestataire ne considère pas ce paiement comme abouti : rien à finaliser.');
    if (!normalized) {
      // Réponse vide : ce n'est pas « non payé », c'est « pas de réponse
      // exploitable ». Le distinguer évite de conclure trop vite.
      console.log('    (réponse VIDE, pas un refus : le paiement peut être passé sans que');
      console.log('     ce contrôle sache le lire. Vérifier le tableau de bord du prestataire,');
      console.log('     puis --force pour finaliser malgré tout.)');
    }
    return;
  }
  if (!isPaidLike(normalized) && force) {
    console.log('  ⚠ FORCÉ : le prestataire ne confirme pas, finalisation demandée explicitement.');
    console.log('    À n\'utiliser qu\'après avoir vérifié le paiement dans le tableau de bord.');
  }
  if (order.status === 'paid') {
    console.log('  → Déjà finalisée localement, cohérent avec le prestataire.');
    return;
  }
  const wasCanceled = order.status === 'canceled';
  if (wasCanceled && !allowCanceled) {
    console.log('  ⚠ Commande ANNULÉE alors que le prestataire dit PAYÉ.');
    console.log('    Cause typique : la sentinelle l\'a annulée sur expiration du délai (PENDING_MAX_MIN)');
    console.log('    pendant que le paiement aboutissait. Ajouter --canceled pour la réanimer.');
    return;
  }
  if (!commit) {
    console.log('  ⚠ ' + (isPaidLike(normalized) ? 'Le prestataire dit PAYÉ' : 'Finalisation FORCÉE demandée') + ' alors que la commande est encore « ' + order.status + ' ».');
    console.log('    Relancer avec --commit pour finaliser (réserve les sièges et envoie le courriel).');
    if (wasCanceled) {
      console.log('    ⚠ Elle a été ANNULÉE : ses sièges ont été libérés et peuvent avoir été repris.');
    }
    return;
  }

  if (wasCanceled) {
    // finalizePaidIfNoConflict refuse par principe une commande annulée. La
    // réanimation est donc un geste explicite : on la repasse « pending », et
    // c'est le contrôle de conflit habituel qui tranche — les sièges libérés
    // ont pu être repris entre-temps, auquel cas la commande finira « failed »
    // et le client devra être replacé ou remboursé.
    console.log(isPaidLike(normalized)
      ? '  ↻ Réanimation d\'une commande annulée (le prestataire confirme le paiement).'
      : '  ↻ Réanimation d\'une commande annulée (FORCÉE, sans confirmation du prestataire).');
    order.status = 'pending';
    order.paymentProviderMeta = {
      ...(order.paymentProviderMeta || {}),
      revivedFromCanceled: true,
      revivedAt: new Date(),
      revivedBy: 'check-order-payment'
    };
    await order.save();
  }

  // Trace indispensable, et indépendante de la réanimation : une finalisation
  // forcée n'est adossée à aucune confirmation du prestataire. Sans marqueur,
  // rien ne la distinguerait plus tard d'un paiement régulièrement constaté.
  if (force && !isPaidLike(normalized)) {
    order.paymentProviderMeta = {
      ...(order.paymentProviderMeta || {}),
      forcedFinalize: true,
      forcedAt: new Date(),
      forcedBy: 'check-order-payment',
      forcedProviderStatus: String(raw ?? '')
    };
    await order.save();
  }

  const fin = await finalizePaidIfNoConflict(order);
  if (!fin.ok) {
    if (fin.duplicate) {
      // Cas courant en test comme en production : le payeur a déjà une commande
      // payée pour cette saison. L'index uniq_paid_per_payer l'interdit — un
      // seul paiement abouti par personne, par saison et par groupKey.
      console.log('  ❌ Ce payeur a DÉJÀ une commande payée pour cette saison.');
      console.log('     index uniq_paid_per_payer : (saison, lieu, groupKey, payeur) — un seul « paid ».');
      console.log('     Soit ce paiement fait double emploi (à rembourser), soit il s\'agit d\'un');
      console.log('     second achat légitime — et c\'est alors l\'index qu\'il faut revoir.');
      console.log('     Les sièges ont été remis dans leur état antérieur ; la commande est « failed ».');
      return;
    }
    console.log(`  ❌ Finalisation impossible : ${fin.blocked ? 'bloquée' : 'conflit de sièges'} — ${JSON.stringify(fin.conflicts || [])}`);
    if (wasCanceled) {
      console.log('     La commande avait été annulée : ses places ont été reprises entre-temps.');
      console.log('     Le client a payé — il faut le replacer (seat-change) ou le rembourser.');
    }
    return;
  }
  console.log('  ✅ Commande finalisée.');
  if (!fin.alreadyFinalized) {
    try {
      await sendOrderAttestationIfNeeded(order, { source: 'check-order-payment' });
      console.log('  ✅ Courriel de confirmation envoyé.');
    } catch (e) {
      console.log(`  ⚠ Courriel non envoyé : ${e?.message || e}`);
    }
  }
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('order', { type: 'string', desc: 'Identifiant de commande' })
    .option('pending', { type: 'boolean', default: false, desc: 'Passe en revue toutes les commandes en attente' })
    .option('canceled', { type: 'boolean', default: false, desc: 'Inclut les commandes ANNULÉES (réanimation)' })
    .option('force', { type: 'boolean', default: false, desc: 'Finalise MÊME SI le prestataire ne confirme pas (dépannage)' })
    .option('season', { type: 'string', desc: 'Restreindre --pending à une saison' })
    .option('commit', { type: 'boolean', default: false, desc: 'Finalise si le prestataire dit payé' })
    .help().argv;

  if (!argv.order && !argv.pending && !argv.canceled) {
    throw new Error('Préciser --order=<id>, --pending ou --canceled');
  }

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  await mongoose.connect(uri, process.env.MONGODB_DB ? { dbName: process.env.MONGODB_DB } : {});

  console.log(`Environnement chargé  : ${ENV.files.join(', ') || '(aucun)'}`);
  console.log(`Prestataire configuré : ${currentPaymentProviderId()}`);

  if (argv.order) {
    const order = await Order.findById(String(argv.order).trim());
    if (!order) throw new Error(`Commande introuvable : ${argv.order}`);
    await inspect(order, { commit: argv.commit, allowCanceled: argv.canceled, force: argv.force });
  } else {
    // 'refunded' n'est JAMAIS inclus : l'argent est rendu, réanimer la commande
    // rendrait la place à quelqu'un qui a été remboursé.
    const wanted = ['pending', 'tobepaid'];
    if (argv.canceled) wanted.push('canceled');
    const where = { status: { $in: wanted } };
    if (argv.season) where.seasonCode = argv.season;
    const orders = await Order.find(where).sort({ createdAt: -1 }).limit(50);
    console.log(`${orders.length} commande(s) ${wanted.join('/')}${argv.season ? ` pour ${argv.season}` : ''}.`);
    for (const o of orders) await inspect(o, { commit: argv.commit, allowCanceled: argv.canceled, force: argv.force });
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
