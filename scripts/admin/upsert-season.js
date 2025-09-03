#!/usr/bin/env node
/**
 * Usage:
 *   node scripts/admin/upsert-season.js <seasonCode> --name="Saison ..." --renewal-open --renewal-close
 *   node scripts/admin/upsert-season.js 2025-2026 --name="Saison 2025-2026" --renewal-open="2025-08-01T00:00:00Z" --renewal-close="2025-09-15T22:00:00Z"
 *   node scripts/admin/upsert-season.js 2025-2026 --enable-renewal --disable-public
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import { Season } from '../../src/models/Season.js';

function arg(name, def = null) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=')[1] : def;
}

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('Missing MONGO_URI/MONGODB_URI'); process.exit(1); }
  await mongoose.connect(uri);

  const code      = process.argv[2] || process.env.SEASON || '2025-2026';
  const name      = arg('name', `Saison ${code}`);
  const activeStr = arg('active', 'true');              // --active=false pour désactiver
  const active    = String(activeStr).toLowerCase() !== 'false';
  const venueSlug = arg('venue', process.env.VENUE);    // <-- important

  const $set = { code, name, active };
  if (venueSlug) $set.venueSlug = venueSlug;

  const season = await Season.findOneAndUpdate(
    { code },
    { $set },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (season.active) {
    await Season.updateMany({ _id: { $ne: season._id } }, { $set: { active: false } });
  }

  console.log('✓ Season upserted:', {
    code: season.code, name: season.name, active: season.active,
    venueSlug: season.venueSlug, phases: season.phases
  });
  await mongoose.disconnect();
  process.exit(0);
})().catch(async e => { console.error(e); try{await mongoose.disconnect();}catch{} process.exit(1); });
