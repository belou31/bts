/**
 * Backfill Event.sale / Event.activity from the legacy isOnSale boolean.
 *
 * Existing events are assumed already-published (activity=active), not
 * draft — draft is only the default for events created after this migration.
 * sale is derived as: isOnSale===true -> 'onsale', else 'notopen'.
 *
 * Usage:
 *   node scripts/migrations/migrate-event-sale-activity.js            # dry-run, prints the plan
 *   node scripts/migrations/migrate-event-sale-activity.js --apply    # writes sale/activity
 *   node scripts/migrations/migrate-event-sale-activity.js --apply --drop-legacy
 *     # also $unset isOnSale once sale/activity are verified correct
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Event } from '../../src/models/Event.js';

import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('apply', { type: 'boolean', default: false, desc: 'Write changes (default: dry-run)' })
    .option('drop-legacy', { type: 'boolean', default: false, desc: 'Also $unset isOnSale (requires --apply)' })
    .help().argv;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');

  const connectOpts = {};
  if (dbName) connectOpts.dbName = dbName;
  await mongoose.connect(uri, connectOpts);

  const docs = await Event.collection.find({}, { projection: { slug: 1, isOnSale: 1, sale: 1, activity: 1 } }).toArray();

  let toUpdate = 0;
  for (const doc of docs) {
    const needsSale = doc.sale === undefined;
    const needsActivity = doc.activity === undefined;
    if (!needsSale && !needsActivity) continue;
    toUpdate++;

    const nextSale = needsSale ? (doc.isOnSale === true ? 'onsale' : 'notopen') : doc.sale;
    const nextActivity = needsActivity ? 'active' : doc.activity;
    console.log(`${argv.apply ? '✅' : '·'} ${doc.slug}: sale=${nextSale} activity=${nextActivity} (isOnSale was ${doc.isOnSale === true})`);

    if (argv.apply) {
      await Event.collection.updateOne({ _id: doc._id }, { $set: { sale: nextSale, activity: nextActivity } });
    }
  }

  console.log(`\n${toUpdate}/${docs.length} event(s) ${argv.apply ? 'updated' : 'would be updated'}.`);

  if (argv.apply && argv['drop-legacy']) {
    const res = await Event.collection.updateMany({ isOnSale: { $exists: true } }, { $unset: { isOnSale: '' } });
    console.log(`Dropped legacy isOnSale field from ${res.modifiedCount} event(s).`);
  } else if (argv['drop-legacy'] && !argv.apply) {
    console.log('(--drop-legacy ignored: requires --apply)');
  }

  if (!argv.apply) {
    console.log('\nDry-run only — rerun with --apply to write.');
  }

  await mongoose.disconnect();
}

main().catch(async (e) => { console.error('❌', e.message); process.exitCode = 1; try { await mongoose.disconnect(); } catch {} });
