#!/usr/bin/env node
// Normalise zoneKey dans seats & seatcatalogs en le déduisant de seatId (ex: "S1-A-001" -> "S1").
// Usage:
//   node -r dotenv/config scripts/migrations/2025-08-19-fix-zonekeys-from-seatId.js [--season=2025-2026] [--venue=patinoire-blagnac] dotenv_config_path=.env

require('dotenv').config();
const mongoose = require('mongoose');

const Seat = require('../../src/models/Seat');

// seatcatalogs = gabarits (collection utilisée à l'instanciation des saisons)
const SeatCatalog = mongoose.connection.collection('seatcatalogs');

function zoneFromSeatId(id) {
  const m = String(id || '').match(/^([A-Za-z]\d+)-/);
  return m ? m[1].toUpperCase() : null;
}

(async () => {
  const args = process.argv.slice(2);
  const season = (args.find(a => a.startsWith('--season=')) || '').split('=')[1] || null;
  const venue  = (args.find(a => a.startsWith('--venue=')) || '').split('=')[1] || null;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('Missing MONGO_URI'); process.exit(1); }
  await mongoose.connect(uri);

  // --- seats (instanciés par saison/lieu)
  const qSeats = {};
  if (season) qSeats.seasonCode = season;
  if (venue)  qSeats.venueSlug  = venue;

  const seats = await Seat.find(qSeats, { seatId: 1, zoneKey: 1 }).lean();
  let updSeats = 0, skipSeats = 0;
  for (const s of seats) {
    const derived = zoneFromSeatId(s.seatId);
    if (derived && derived !== s.zoneKey) {
      await Seat.updateOne({ _id: s._id }, { $set: { zoneKey: derived } });
      updSeats++;
    } else {
      skipSeats++;
    }
  }

  // --- seatcatalogs (gabarits)
  const qCat = {};
  if (venue) qCat.venueSlug = venue;

  const catDocs = await SeatCatalog.find(qCat, { projection: { seatId: 1, zoneKey: 1 } }).toArray();
  let updCat = 0, skipCat = 0;
  for (const c of catDocs) {
    const derived = zoneFromSeatId(c.seatId);
    if (derived && derived !== c.zoneKey) {
      await SeatCatalog.updateOne({ _id: c._id }, { $set: { zoneKey: derived } });
      updCat++;
    } else {
      skipCat++;
    }
  }

  console.log(`[fix-zonekeys] seats updated=${updSeats} skipped=${skipSeats}; catalogs updated=${updCat} skipped=${skipCat}`);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('ERROR', e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
