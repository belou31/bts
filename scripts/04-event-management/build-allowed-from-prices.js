// scripts/03-event-management/events/build-allowed-from-prices.js
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Event } from '../../src/models/Event.js';
import { Zone } from '../../src/models/Zone.js';
import { Seat } from '../../src/models/Seat.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';
import { withMetaZonePrices } from '../../src/utils/meta-zones.js';

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

  const [rawPrices, publicZones] = await Promise.all([
    // metaZone doit être projetée : le modèle impose zoneKey OU metaZone, donc
    // une ligne écrite pour une méta-zone n'a PAS de zoneKey. Sans elle, toute
    // grille tarifaire rédigée par méta-zone paraissait vide ici et l'événement
    // n'autorisait plus que les zones tarifées nommément.
    TariffPrice.find({ priceTableKey: ev.priceTableKey }, { zoneKey:1, metaZone:1, tariffCode:1, _id:0 }).lean(),
    Zone.find({ seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, access: 'PUBLIC' }, { key:1, _id:0 }).lean().catch(()=>[])
  ]);

  // Même résolution que les routes publiques : une ligne méta-zone est
  // dépliée en une ligne par zone rattachée (src/utils/meta-zones.js).
  const prices = await withMetaZonePrices(rawPrices, {
    seasonCode: ev.seasonCode,
    venueSlug: ev.venueSlug
  });

  const pricedZones = uniq(prices.map(p => String(p.zoneKey || '').toUpperCase()).filter(Boolean));
  const fromMetaZones = uniq(rawPrices.map(p => String(p.metaZone || '').toUpperCase()).filter(Boolean));
  let allowedZones = pricedZones;
  if (Array.isArray(publicZones) && publicZones.length > 0) {
    const publicSet = new Set(
      publicZones.map(z => String(z.key || '').toUpperCase()).filter(Boolean)
    );
    allowedZones = pricedZones.filter(z => publicSet.has(String(z).toUpperCase()));
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

  // Un compte nul est presque toujours un problème de configuration, pas un
  // résultat : le dire ici évite de le découvrir sur la billetterie.
  if (!seatCount) {
    console.warn('⚠ Aucun siège sélectionnable pour ces zones.');
    if (!allowedZones.length) {
      console.warn('  Aucune zone autorisée : vérifier la grille tarifaire de ' + ev.priceTableKey + '.');
    } else {
      console.warn('  Zones autorisées : ' + allowedZones.join(', '));
      console.warn('  Causes usuelles : zones en places debout (aucun siège), sièges non instanciés');
      console.warn('  pour ' + ev.seasonCode + ' / ' + ev.venueSlug + ', ou tous déjà réservés.');
    }
  }

  console.log(JSON.stringify({
    ok: true,
    event: ev.slug,
    allowedZones,
    // Ce qui vient d'une méta-zone est distingué : sans cela, une grille
    // rédigée par méta-zone et une grille zone par zone sont indiscernables.
    metaZones: fromMetaZones,
    seatCount
  }, null, 2));
  await mongoose.disconnect();
}

main().catch(async e => { console.error('❌', e.message); process.exitCode=1; try{await mongoose.disconnect();}catch{} });
