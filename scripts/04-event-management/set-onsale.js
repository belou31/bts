/**
 * Toggle event on-sale flag.
 *
 * Usage:
 *   node scripts/03-event-management/events/set-onsale.js --event=match-2025-09-21-bts-vs-xxx --open
 *   node scripts/03-event-management/events/set-onsale.js --event=66fdb9... --on=false
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 *   - MONGODB_DB (optional database name)
 *
 * Template:
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Event } from '../../../src/models/Event.js';

import dotenv from 'dotenv';
dotenv.config();

async function main(){
  const argv = yargs(hideBin(process.argv))
    .option('event', { type:'string', demandOption:true, desc:'eventId ou slug' })
    .option('on', { type:'boolean', desc:'true = vente ouverte ; false = fermée' })
    .option('open', { type:'boolean', desc:'Alias de --on=true' })
    .option('close', { type:'boolean', desc:'Alias de --on=false' })
    .conflicts('open', 'close')
    .help().argv;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');

  const connectOpts = {};
  if (dbName) connectOpts.dbName = dbName;
  await mongoose.connect(uri, connectOpts);

  let desiredState;
  if (argv.on !== undefined) desiredState = !!argv.on;
  if (argv.open !== undefined) desiredState = true;
  if (argv.close !== undefined) desiredState = false;

  if (desiredState === undefined) {
    throw new Error('Précisez --on=true|false ou --open / --close');
  }

  const q = argv.event.match(/^[0-9a-f]{24}$/i) ? { _id: argv.event } : { slug: argv.event };
  const res = await Event.findOneAndUpdate(q, { $set: { isOnSale: desiredState } }, { new:true });
  if (!res) throw new Error('Event introuvable');
  console.log('✅', res.slug, 'isOnSale =', res.isOnSale);

  await mongoose.disconnect();
}
main().catch(async (e)=>{ console.error('❌', e.message); process.exitCode=1; try{await mongoose.disconnect();}catch{} });
