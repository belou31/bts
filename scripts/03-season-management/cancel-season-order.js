#!/usr/bin/env node
/**
 * Annule (soft) ou supprime (hard) une commande de SAISON — abonnement,
 * renouvellement, achat de bon — et révoque ses billets.
 *
 * Pour une commande rattachée à un match, utiliser
 * scripts/04-event-management/cancel-event-order.js : le geste n'est pas le
 * même. Ici la place est détenue à l'année, et la rendre la remet en vente
 * pour toute la saison.
 *
 * soft : la commande passe à `canceled`. La trace du paiement est conservée —
 *        à préférer presque toujours.
 * hard : le document est supprimé, sans retour. À réserver aux commandes de test.
 *
 * LES PLACES ne sont PAS rendues par défaut : passer --release-seats. Sans
 * cela elles restent réservées au nom d'une commande annulée ou disparue, et
 * le script le dit à chaque fois.
 *
 * Usage:
 *   node scripts/03-season-management/cancel-season-order.js --order=<id> [--mode=soft|hard]
 *   node scripts/03-season-management/cancel-season-order.js --file=<orders.csv>
 *   ... [--commit] [--force] [--release-seats]
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { Order } from '../../src/models/Order.js';
import { Seat } from '../../src/models/Seat.js';
import { Ticket } from '../../src/models/Ticket.js';
import {
  resolveTargets, loadOrder, revokeTickets, shouldSkipPaid,
  describeOrder, realSeatIds, markCanceled, summarize
} from '../lib/order-cancel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const argv = yargs(hideBin(process.argv))
  .option('order',  { type: 'string', desc: 'Identifiant d\'une commande' })
  .option('file',   { type: 'string', desc: 'CSV : colonnes orderId, mode' })
  .option('mode',   { type: 'string', default: 'soft', choices: ['soft', 'hard'], desc: 'Avec --order' })
  .option('commit', { type: 'boolean', default: false })
  .option('force',  { type: 'boolean', default: false, desc: 'Autorise une commande payée' })
  .option('release-seats', { type: 'boolean', default: false, desc: 'Remet les places en vente' })
  .help().argv;

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  await mongoose.connect(uri, process.env.MONGODB_DB ? { dbName: process.env.MONGODB_DB } : {});

  const list = await resolveTargets(argv);
  const releaseSeats = argv['release-seats'];
  console.log(argv.commit ? '⚠️  Commit activé.' : '🧪 Simulation (aucune écriture).');

  let soft = 0, hard = 0, miss = 0, skipped = 0, released = 0, revoked = 0;

  for (const { orderId, mode } of list) {
    const order = await loadOrder(Order, orderId);
    if (!order) { console.warn(`❓ introuvable ${orderId}`); miss++; continue; }

    const seatIds = realSeatIds(order);
    describeOrder(order, seatIds);

    // Une commande rattachée à un match relève de l'autre script : y libérer
    // le siège rendrait la place pour TOUTE la saison, alors que seul ce match
    // est concerné.
    if (order.eventId || order.meta?.eventId) {
      console.log('  ⛔ commande rattachée à un match — utiliser :');
      console.log(`     node scripts/04-event-management/cancel-event-order.js --order=${order._id}`);
      skipped++;
      continue;
    }
    // Signalé AVANT le garde-fou « payée » : c'est justement sur une commande
    // payée qu'on veut voir l'ensemble avant de décider de forcer.
    const derived = await Order.countDocuments({
      parentOrderId: order._id, status: { $in: ['paid', 'tobepaid', 'pending'] }
    });
    if (derived) {
      console.log(`  ⚠ ${derived} commande(s) de match dérivée(s) de cet abonnement restent actives.`);
      console.log('     Les traiter séparément avec cancel-event-order.js.');
    }

    if (shouldSkipPaid(order, argv.force)) { skipped++; continue; }

    if (!argv.commit) {
      console.log(`  🧪 ${mode.toUpperCase()} — et ${releaseSeats
        ? `${seatIds.length} place(s) remise(s) en vente`
        : 'places laissées en l\'état'}`);
      continue;
    }

    const ticketsRemoved = await revokeTickets(Ticket, order);
    revoked += ticketsRemoved;
    const suffix = ticketsRemoved ? ` · ${ticketsRemoved} billet(s) révoqué(s)` : '';

    if (mode === 'hard') {
      await Order.deleteOne({ _id: order._id });
      hard++;
      console.log(`  ✔ supprimée${suffix}`);
    } else {
      markCanceled(order);
      await order.save();
      soft++;
      console.log(`  ✔ annulée (canceled)${suffix}`);
    }

    if (releaseSeats && seatIds.length) {
      const upd = await Seat.updateMany(
        { seasonCode: order.seasonCode, venueSlug: order.venueSlug, seatId: { $in: seatIds } },
        { $set: { status: 'available', provisionedFor: null }, $unset: { 'meta.hold': 1 } }
      );
      const n = Number(upd.modifiedCount ?? upd.nModified ?? 0);
      released += n;
      console.log(`  ✔ ${n} place(s) remise(s) en vente pour toute la saison`);
    } else if (seatIds.length) {
      console.log(`  ⚠ ${seatIds.length} place(s) restent réservées (--release-seats pour les libérer)`);
    }
  }

  summarize({ soft, hard, skipped, miss, revoked, released });
  if (!argv.commit) console.log('Simulation seule. Relancer avec --commit pour écrire.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err?.message || err);
  try { await mongoose.disconnect(); } catch { /* rien de mieux à faire */ }
  process.exit(1);
});
