/**
 * Set an event's sale and/or activity lifecycle state.
 *
 * sale:     notopen -> presale -> onsale -> [soldout] -> closed
 * activity: draft -> active -> archived
 *
 * Usage:
 *   node scripts/04-event-management/publish-event.js --event=match-2025-09-21-bts-vs-xxx --sale=onsale
 *   node scripts/04-event-management/publish-event.js --event=66fdb9... --activity=active
 *   node scripts/04-event-management/publish-event.js --event=match-j1 --sale=onsale --activity=active
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 *   - MONGODB_DB (optional database name)
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Event } from '../../src/models/Event.js';
import { SALE_STATES, ACTIVITY_STATES } from '../../src/utils/event-sale.js';

import dotenv from 'dotenv';
dotenv.config();

async function main(){
  const argv = yargs(hideBin(process.argv))
    .option('event', { type:'string', demandOption:true, desc:'eventId ou slug' })
    .option('sale', { type:'string', choices: SALE_STATES, desc:`Nouvel état de vente (${SALE_STATES.join('|')})` })
    .option('activity', { type:'string', choices: ACTIVITY_STATES, desc:`Nouvel état de publication (${ACTIVITY_STATES.join('|')})` })
    .help().argv;

  if (argv.sale === undefined && argv.activity === undefined) {
    throw new Error('Précisez --sale=<état> et/ou --activity=<état>');
  }

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');

  const connectOpts = {};
  if (dbName) connectOpts.dbName = dbName;
  await mongoose.connect(uri, connectOpts);

  const update = {};
  if (argv.sale !== undefined) update.sale = argv.sale;
  if (argv.activity !== undefined) update.activity = argv.activity;

  const q = argv.event.match(/^[0-9a-f]{24}$/i) ? { _id: argv.event } : { slug: argv.event };
  const res = await Event.findOneAndUpdate(q, { $set: update }, { new:true });
  if (!res) throw new Error('Event introuvable');
  console.log('✅', res.slug, '— sale =', res.sale, ', activity =', res.activity);

  await mongoose.disconnect();
}
main().catch(async (e)=>{ console.error('❌', e.message); process.exitCode=1; try{await mongoose.disconnect();}catch{} });
