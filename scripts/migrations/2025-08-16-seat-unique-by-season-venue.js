// scripts/migrations/2025-08-16-seat-unique-by-season-venue.js
/**
 * - Ajoute venueSlug aux documents Seat existants à partir des saisons
 * - Remplace l'index unique seatId_1 par l'index composé uniq_seat_per_season_venue
 */
require('dotenv').config();

const mongoose = require('mongoose');
const Season = require('../../src/models/Season');

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('Missing MONGO_URI/MONGODB_URI in .env');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const seatsColl = mongoose.connection.collection('seats');

  // 1) Construire une map seasonCode -> venueSlug
  const seasons = await Season.find({}, { code: 1, venueSlug: 1 }).lean();
  const map = new Map(seasons.map(s => [s.code, s.venueSlug || null]));

  // 2) Mettre à jour les seats sans venueSlug, quand la saison a un venueSlug
  let updated = 0;
  for (const [code, venueSlug] of map.entries()) {
    if (!venueSlug) continue;
    const r = await seatsColl.updateMany(
      { seasonCode: code, $or: [{ venueSlug: { $exists: false } }, { venueSlug: null }] },
      { $set: { venueSlug } }
    );
    updated += r.modifiedCount;
  }
  console.error(`Updated seats with venueSlug from seasons: ${updated}`);

  // 3) Indices : drop l'ancien unique "seatId_1" si présent
  const idx = await seatsColl.indexes();
  const hasSeatIdUnique = idx.find(i => i.name === 'seatId_1');
  if (hasSeatIdUnique) {
    console.error('Dropping index seatId_1 ...');
    await seatsColl.dropIndex('seatId_1');
  }

  // 4) Créer l'unique composé si absent
  const hasNew = idx.find(i => i.name === 'uniq_seat_per_season_venue');
  if (!hasNew) {
    console.error('Creating index uniq_seat_per_season_venue ...');
    await seatsColl.createIndex(
      { seasonCode: 1, venueSlug: 1, seatId: 1 },
      { unique: true, name: 'uniq_seat_per_season_venue' }
    );
  }

  console.error('Done.');
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
