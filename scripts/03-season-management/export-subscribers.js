/**
 * Export renewers (subscribers eligible for renewals) to CSV.
 *
 * Usage:
 *   node scripts/03-season-management/export-subscribers.js [--season=2025-2026] [--venue=patinoire-blagnac] [--activeOnly]
 *
 * Output columns:
 *   email,firstName,lastName,seasonCode,venueSlug,prefSeatId,previousSeasonSeats,isActive,notes
 *   previousSeasonSeats is serialized with ";".
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 *   - MONGODB_DB (optional database name)
 *
 * Template:
 *   - data_references/csv/subscribers-export.template.csv
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { Subscriber } from '../../src/models/Subscriber.js';

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) { console.error('MONGO_URI/MONGODB_URI manquant'); process.exit(1); }

const season = process.argv.find(a => a.startsWith('--season='))?.split('=')[1] || null;
const venue  = process.argv.find(a => a.startsWith('--venue='))?.split('=')[1]  || null;
const activeOnly = process.argv.includes('--activeOnly');

if (!season) {
  console.error('Veuillez préciser la saison à exporter: --season=2025-2026');
  process.exit(1);
}

const q = { seasonCode: season };
if (venue)  q.venueSlug  = venue;
if (activeOnly) q.status = 'active';

const csvEscape = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
};

(async () => {
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });
  const cursor = Subscriber.find(q).lean().cursor();

  const header = [
    'email','firstName','lastName','seasonCode','venueSlug',
    'prefSeatId','previousSeasonSeats','isActive','notes'
  ].join(',');
  process.stdout.write(header + '\n');

  for await (const s of cursor) {
    const prev = Array.isArray(s.previousSeasonSeats) ? s.previousSeasonSeats.join(';') : '';
    const row = [
      s.email || '',
      s.firstName || '',
      s.lastName || '',
      s.seasonCode || '',
      s.venueSlug || '',
      s.prefSeatId || '',
      prev,
      (s.status === 'active' ? '1' : '0'),
      s.notes || ''
    ].map(csvEscape).join(',');
    process.stdout.write(row + '\n');
  }

  await mongoose.disconnect();
})();
