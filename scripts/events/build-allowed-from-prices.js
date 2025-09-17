// scripts/events/build-allowed-from-prices.js
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Event } from '../../src/models/Event.js';
import { Zone } from '../../src/models/Zone.js';
import { Seat } from '../../src/models/Seat.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';

import dotenv from 'dotenv';
dotenv.config();

function uniq(arr){ return Array.from(new Set(arr)); }

async function main(){
  const argv = yargs(hideBin(process.argv))
    .option('event', { type:'string', demandOption:true, desc:'eventId ou slug' })
    .help().argv;

  const uri = process.env.MONGO_URI;
  const dbn = "bts";
  if (!uri || !dbn) throw new Error('MONGO_URI / MONGODB_DB requis');

  await mongoose.connect(uri, { dbName: dbn });
  const ev = await (async () => {
    if (/^[0-9a-f]{24}$/i.test(argv.event)) return Event.findById(argv.event).lean();
    return Event.findOne({ slug: argv.event }).lean();
  })();
  if (!ev) throw new Error('Event introuvable');

  const [prices, publicZones] = await Promise.all([
    TariffPrice.find({ priceTableKey: ev.priceTableKey }, { zoneKey:1, tariffCode:1, _id:0 }).lean(),
    Zone.find({ seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, access: 'PUBLIC' }, { zoneKey:1, _id:0 }).lean().catch(()=>[])
  ]);

  const pricedZones = uniq(prices.map(p => String(p.zoneKey)));
  let allowedZones = pricedZones;
  if (Array.isArray(publicZones) && publicZones.length > 0) {
    const publicSet = new Set(publicZones.map(z => String(z.zoneKey)));
    allowedZones = pricedZones.filter(z => publicSet.has(z));
  }

  // Compte des sièges "sélectionnables" (status available + zone autorisée)
  const seatCount = await Seat.countDocuments({
    seasonCode: ev.seasonCode, venueSlug: ev.venueSlug,
    status: 'available', zoneKey: { $in: allowedZones }
  });

  // Option: stocker un résumé sur l'event (lisible dans /admin)
  await Event.updateOne({ _id: ev._id }, {
    $set: { 'meta.allowed': { zones: allowedZones, seatCount, computedAt: new Date() } }
  });

  console.log(JSON.stringify({ ok:true, event: ev.slug, allowedZones, seatCount }, null, 2));
  await mongoose.disconnect();
}

main().catch(async e => { console.error('❌', e.message); process.exitCode=1; try{await mongoose.disconnect();}catch{} });
