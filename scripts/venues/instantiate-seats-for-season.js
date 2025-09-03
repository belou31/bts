#!/usr/bin/env node
// scripts/venues/instantiate-seats-for-season.js
// Usage:
//   node scripts/venues/instantiate-seats-for-season.js <seasonCode> <venueSlug>
//
// Lit la collection de gabarits (issue de l'import SVG) quel que soit son nom,
// puis instancie les sièges pour la saison/lieu dans la collection "seats".

import mongoose from 'mongoose';
import { Seat } from '../../src/models/Seat.js';
import { SeatCatalog } from '../../src/models/SeatCatalog.js';

import dotenv from 'dotenv';
dotenv.config();

function zoneFromSeatId(seatId) {
  const s = String(seatId || '');
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : null;
}

(async () => {
  const [,, seasonCode, venueSlug] = process.argv;
  if (!seasonCode || !venueSlug) {
    console.error('Usage: node scripts/venues/instantiate-seats-for-season.js <seasonCode> <venueSlug>');
    process.exit(1);
  }

  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('Missing MONGO_URI in .env'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  const collections = await db.listCollections().toArray();
  const names = collections.map(c => c.name);

  // ➜ Ajout de 'seatcatalogs' (ton cas)
  const candidates = [
    'seatcatalogs',          // <== présent chez toi
    'seat_catalogs',
    'seat_catalog',
    'venueSeatTemplates',
    'venue_seat_templates',
    'venueSeats',
    'venue_seat_catalog',
  ];

  let templateColName = null;
  for (const name of candidates) {
    if (!names.includes(name)) continue;
    const col = db.collection(name);
    const cnt = await col.countDocuments({ venueSlug });
    if (cnt > 0) {
      templateColName = name;
      break;
    }
  }

  if (!templateColName) {
    console.error('Aucune collection de gabarits de sièges trouvée pour venueSlug =', venueSlug);
    console.error('Collections présentes :', names.join(', '));
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Using template collection: ${templateColName}`);

  const templates = await db.collection(templateColName)
    .find({ venueSlug })
    .project({ seatId: 1, zoneKey: 1 })
    .toArray();

  console.log(`Templates trouvés: ${templates.length}`);

  let created = 0, skipped = 0, errors = 0;
  for (const t of templates) {
    const seatId = t?.seatId;
    if (!seatId) { errors++; continue; }
    const zoneKey = t?.zoneKey || zoneFromSeatId(seatId);

    const res = await Seat.updateOne(
      { seasonCode, venueSlug, seatId },
      { $setOnInsert: { zoneKey, status: 'available', provisionedFor: null } },
      { upsert: true }
    );

    if (res.upsertedCount && res.upsertedCount > 0) created++;
    else skipped++;
  }

  console.log(`Instantiated seats for season ${venueSlug} @ ${seasonCode}: created=${created}, skipped=${skipped}, errors=${errors}`);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
