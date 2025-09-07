// scripts/export-seats.js
import mongoose from 'mongoose';
import { Seat } from '../../src/models/Seat.js';

import dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI manquant'); process.exit(1); }

const season = process.argv.find(a => a.startsWith('--season='))?.split('=')[1] || null;
const venue  = process.argv.find(a => a.startsWith('--venue='))?.split('=')[1]  || null;

const q = {};
if (season) q.seasonCode = season;
if (venue)  q.venueSlug  = venue;

const csvEscape = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
};

(async () => {
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });

  const cursor = Seat.find(q, { _id:0 }).lean().cursor();
  process.stdout.write(['seasonCode','venueSlug','seatId','zoneKey','status'].join(',') + '\n');

  for await (const s of cursor) {
    const row = [
      s.seasonCode||'', s.venueSlug||'', s.seatId||'', s.zoneKey||'', s.status||''
    ].map(csvEscape).join(',');
    process.stdout.write(row + '\n');
  }
  await mongoose.disconnect();
})();
