#!/usr/bin/env node
/**
 * Supprime les lignes de renouvellement (Subscriber) d'une saison, pour
 * repartir d'un import propre.
 *
 * Ordre des opérations, et pourquoi il compte :
 * `renewal-provision-seats.js` met les sièges à `provisioned` avec
 * `Seat.provisionedFor = <Subscriber._id>`. Supprimer les abonnés sans libérer
 * ces sièges laisse des places bloquées pointant vers des documents qui
 * n'existent plus : plus personne ne peut les prendre, et plus rien n'indique
 * pourquoi. Ce script refuse donc de supprimer tant que des sièges sont
 * provisionnés, sauf si on lui demande explicitement de les libérer.
 *
 * Ne touche jamais :
 *   - les sièges `booked` (renouvellement déjà payé),
 *   - les commandes (Order) : un renouvellement payé reste payé.
 *
 * Usage:
 *   node scripts/03-season-management/remove-renewers.js --season=<code> [--venue=<slug>]
 *   node scripts/03-season-management/remove-renewers.js --season=<code> --commit
 *   node scripts/03-season-management/remove-renewers.js --season=<code> --commit --release-seats
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import dotenv from 'dotenv';
dotenv.config();

import { Subscriber } from '../../src/models/Subscriber.js';
import { Seat } from '../../src/models/Seat.js';
import { Order } from '../../src/models/Order.js';

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('season', { type: 'string', demandOption: true, desc: 'Code saison' })
    .option('venue', { type: 'string', desc: 'Slug du lieu (sinon toute la saison)' })
    .option('commit', { type: 'boolean', default: false, desc: 'Supprime réellement (sinon état des lieux)' })
    .option('release-seats', { type: 'boolean', default: false, desc: 'Libère aussi les sièges provisionnés' })
    .help().argv;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  const opts = {};
  if (process.env.MONGODB_DB) opts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, opts);

  const where = { seasonCode: argv.season };
  if (argv.venue) where.venueSlug = argv.venue;
  const scope = `${argv.season}${argv.venue ? ` / ${argv.venue}` : ''}`;

  const subs = await Subscriber.find(where, { _id: 1, email: 1, prefSeatId: 1, places: 1 }).lean();
  if (!subs.length) {
    console.log(`Aucun renouveleur pour ${scope} — rien à faire.`);
    await mongoose.disconnect();
    return;
  }

  const ids = subs.map(s => s._id);
  const seatFilter = { seasonCode: argv.season, status: 'provisioned', provisionedFor: { $in: ids } };
  if (argv.venue) seatFilter.venueSlug = argv.venue;
  const provisioned = await Seat.countDocuments(seatFilter);

  // Un renouvellement déjà payé n'est pas annulé par cette suppression, mais le
  // signaler évite de croire qu'on efface une campagne encore vierge.
  const emails = [...new Set(subs.map(s => String(s.email || '').trim().toLowerCase()).filter(Boolean))];
  const paid = emails.length
    ? await Order.countDocuments({
        seasonCode: argv.season,
        status: 'paid',
        'origin.flow': 'renew',
        payerEmail: { $in: emails }
      })
    : 0;

  const places = subs.reduce((sum, s) => sum + Math.max(1, Number(s.places) || 1), 0);
  console.log(`Périmètre : ${scope}`);
  console.log(`  lignes de renouvellement : ${subs.length} (${places} place(s))`);
  console.log(`  sièges provisionnés      : ${provisioned}`);
  console.log(`  renouvellements DÉJÀ PAYÉS : ${paid}`);
  if (paid) {
    console.log('    ⚠ ces commandes ne sont PAS supprimées ; leurs sièges restent `booked`.');
  }

  if (!argv.commit) {
    console.log('\n🧪 État des lieux seul — relancer avec --commit pour supprimer.');
    if (provisioned) {
      console.log(`   ${provisioned} siège(s) provisionné(s) : ajouter --release-seats pour les rendre disponibles.`);
    }
    await mongoose.disconnect();
    return;
  }

  if (provisioned && !argv['release-seats']) {
    console.error(`\n❌ ${provisioned} siège(s) encore provisionné(s) pour ces renouveleurs.`);
    console.error('   Les supprimer maintenant laisserait ces sièges bloqués sans propriétaire.');
    console.error('   Relancer avec --release-seats, ou libérer d\'abord :');
    console.error(`   node scripts/03-season-management/release-unrenewed-seats.js ${argv.season}${argv.venue ? ` --venue=${argv.venue}` : ''}`);
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  if (provisioned && argv['release-seats']) {
    const res = await Seat.updateMany(seatFilter, { $set: { status: 'available', provisionedFor: null } });
    console.log(`\n✅ ${res.modifiedCount} siège(s) libéré(s).`);
  }

  const del = await Subscriber.deleteMany(where);
  console.log(`✅ ${del.deletedCount} ligne(s) de renouvellement supprimée(s) pour ${scope}.`);
  console.log('   Prochaine étape : import-renewers-flat.js pour repartir d\'un fichier propre.');

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
