// scripts/events/create.js
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Event } from '../../src/models/Event.js';

import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('slug', { type:'string', demandOption:true, desc:'Ex: match-2025-09-21-bts-vs-xxx' })
    .option('name', { type:'string', demandOption:true, desc:'Titre affiché (ex: BTS vs XXX)' })
    .option('date', { type:'string', demandOption:true, desc:'Date ISO (ex: 2025-09-21T16:00:00+02:00)' })
    .option('season', { type:'string', demandOption:true, desc:'Code saison (ex: 2025-2026)' })
    .option('venue', { type:'string', demandOption:true, desc:'Slug du lieu (ex: patinoire-blagnac)' })
    .option('desc', { type:'string', default:'', desc:'Description courte' })
    .option('onsale', { type:'boolean', default:false, desc:'Ouvrir la vente directement ?' })
    .help().argv;
  const uri = process.env.MONGO_URI;
  const dbn = "bts";

  if (!uri || !dbn) throw new Error('MONGO_URI / MONGODB_DB requis');

  await mongoose.connect(uri, { dbName: dbn });

  const priceTableKey = `ev:${argv.slug}`;
  const startsAt = new Date(argv.date);
  if (isNaN(startsAt)) throw new Error('Date invalide');

  const doc = await Event.create({
    slug: argv.slug,
    name: argv.name,
    startsAt,
    seasonCode: argv.season,
    venueSlug: argv.venue,
    priceTableKey,
    isOnSale: argv.onsale,
    description: argv.desc,
    qrBank: { provider: 'bank', buckets: {} }
  });

  console.log('✅ Event créé :', { id: String(doc._id), slug: doc.slug, priceTableKey });
  await mongoose.disconnect();
}

main().catch(async (e) => { console.error('❌', e.message); process.exitCode = 1; try{await mongoose.disconnect();}catch{} });
