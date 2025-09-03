#!/usr/bin/env node
// scripts/pricing/clone-zone-tariffs.mjs
import 'dotenv/config';
import mongoose from 'mongoose';
import minimist from 'minimist';
import { TariffPrice, Season } from '../../src/models/index.js';

const args = minimist(process.argv.slice(2), {
  string: ['season','venue','from-zone','to-zones','discount'],
  alias: { s:'season', v:'venue', f:'from-zone', t:'to-zones', d:'discount' }
});

const seasonCode = args.season;
let   venueSlug  = args.venue || null;
const fromZone   = String(args['from-zone'] || '').trim();
const toZones    = String(args['to-zones'] || '').split(',').map(s => s.trim()).filter(Boolean);
const discount   = Math.max(0, Number(args.discount || 0)); // en %

if (!seasonCode || !fromZone || !toZones.length) {
  console.error('Usage: node scripts/pricing/clone-zone-tariffs.mjs --season 2025-2026 --venue patinoire-blagnac --from-zone A1 --to-zones TBH7,TBH7-VIRAGE [--discount 30]');
  process.exit(1);
}

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bts';

function pct(v, d) { return Math.max(0, Math.round(v * (1 - d/100))); }

(async () => {
  await mongoose.connect(MONGO_URI, { autoIndex: true });
  try {
    if (!venueSlug) {
      const season = await Season.findOne({ code: seasonCode }).lean();
      if (!season?.venueSlug) throw new Error('venueSlug introuvable : passe --venue ou renseigne Season.venueSlug');
      venueSlug = season.venueSlug;
    }

    const source = await TariffPrice.find({ seasonCode, venueSlug, zoneKey: fromZone }).lean();
    if (!source.length) throw new Error(`Aucun TariffPrice pour zone source "${fromZone}" (season=${seasonCode}, venue=${venueSlug})`);

    let created = 0, updated = 0;
    for (const zk of toZones) {
      for (const r of source) {
        const price = discount ? pct(r.priceCents, discount) : r.priceCents;
        const res = await TariffPrice.updateOne(
          { seasonCode, venueSlug, zoneKey: zk, tariffCode: r.tariffCode },
          { $set: { priceCents: price } },
          { upsert: true }
        );
        if (res.upsertedCount) created++; else if (res.modifiedCount) updated++;
      }
    }

    console.log(`[ok] season=${seasonCode} venue=${venueSlug}`);
    console.log(`    cloned from "${fromZone}" -> [${toZones.join(', ')}] (discount ${discount}%)`);
    console.log(`    upserts: created=${created}, updated=${updated}`);
  } catch (e) {
    console.error('[error]', e.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
