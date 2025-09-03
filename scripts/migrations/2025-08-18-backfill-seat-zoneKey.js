/**
 * Backfill Seat.zoneKey depuis seatId (ex: "S1-A-001" -> "S1").
 * Usage :
 *   APP_ENV=development node scripts/migrations/2025-08-18-backfill-seat-zoneKey.js 2025-2026 patinoire-blagnac
 *   APP_ENV=integration node scripts/migrations/2025-08-18-backfill-seat-zoneKey.js 2025-2026 patinoire-blagnac
 *   APP_ENV=production  node scripts/migrations/2025-08-18-backfill-seat-zoneKey.js 2025-2026 patinoire-blagnac
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
function loadEnv() {
  const env = (process.env.APP_ENV || 'development').toLowerCase();
  const candidates = [
    process.env.DOTENV_PATH,
    `.env.${env}`,
    env === 'development' ? '.env.dev' : null,
    '.env',
  ].filter(Boolean);
  for (const p of candidates) {
    const abs = path.resolve(process.cwd(), p);
    if (fs.existsSync(abs)) {
      require('dotenv').config({ path: abs });
      console.log(`[backfill-seat-zoneKey] Loaded env file: ${p} (APP_ENV=${env})`);
      return;
    }
  }
  require('dotenv').config();
}
loadEnv();

const mongoose = require('mongoose');
const Seat = require('../../src/models/Seat');

function deriveZoneFromSeatId(seatId) {
  const id = String(seatId || '');
  let m = /^([A-Z]\d+)-/.exec(id);
  if (m) return m[1];
  m = /^([A-Z])-/.exec(id);
  return m ? m[1] : null;
}

(async () => {
  const [,, seasonCode, venueSlug] = process.argv;
  if (!seasonCode || !venueSlug) {
    console.error('Usage: node scripts/migrations/2025-08-18-backfill-seat-zoneKey.js <seasonCode> <venueSlug>');
    process.exit(1);
  }

  const env = (process.env.APP_ENV || 'development').toLowerCase();
  const mongoUri =
    env === 'production'  ? process.env.MONGO_URI_PROD :
    env === 'integration' ? process.env.MONGO_URI_INT  :
    (process.env.MONGO_URI_DEV || process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bts');

  if (!mongoUri) { console.error('Missing Mongo URI'); process.exit(1); }
  await mongoose.connect(mongoUri);

  const cur = Seat.find({ seasonCode, venueSlug }, { _id:1, seatId:1, zoneKey:1 }).cursor();

  let scanned = 0, updated = 0, missing = 0;
  for await (const s of cur) {
    scanned++;
    const derived = deriveZoneFromSeatId(s.seatId);
    if (!derived) { missing++; continue; }
    if (s.zoneKey !== derived) {
      await Seat.updateOne({ _id: s._id }, { $set: { zoneKey: derived } });
      updated++;
    }
  }

  console.log(`[backfill-seat-zoneKey] scanned=${scanned} updated=${updated} missing=${missing}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error('[backfill-seat-zoneKey] ERROR', e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
