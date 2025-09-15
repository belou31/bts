// scripts/events/set-onsale.js
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Event } from '../../src/models/Event.js';

import dotenv from 'dotenv';
dotenv.config();

async function main(){
  const argv = yargs(hideBin(process.argv))
    .option('event', { type:'string', demandOption:true, desc:'eventId ou slug' })
    .option('on', { type:'boolean', demandOption:true, desc:'true = vente ouverte ; false = fermée' })
    .help().argv;

  const uri = process.env.MONGO_URI;
  const dbn = "bts";
  if (!uri || !dbn) throw new Error('MONGO_URI / MONGODB_DB requis');

  await mongoose.connect(uri, { dbName: dbn });

  const q = argv.event.match(/^[0-9a-f]{24}$/i) ? { _id: argv.event } : { slug: argv.event };
  const res = await Event.findOneAndUpdate(q, { $set: { isOnSale: !!argv.on } }, { new:true });
  if (!res) throw new Error('Event introuvable');
  console.log('✅', res.slug, 'isOnSale =', res.isOnSale);

  await mongoose.disconnect();
}
main().catch(async (e)=>{ console.error('❌', e.message); process.exitCode=1; try{await mongoose.disconnect();}catch{} });
