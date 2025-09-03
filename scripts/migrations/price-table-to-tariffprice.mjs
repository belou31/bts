import 'dotenv/config';
import mongoose from 'mongoose';
import minimist from 'minimist';
import { Tariff, TariffPrice, PriceTable } from '../../src/models/index.js';

const args = minimist(process.argv.slice(2), {
  string: ['season', 'venue'],
  alias: { s: 'season', v: 'venue' }
});
const seasonCode = args.season;
const venueSlug  = args.venue;

if (!seasonCode || !venueSlug) {
  console.error('Usage: node scripts/migrations/price-table-to-tariffprice.mjs --season 2025-2026 --venue patinoire-blagnac');
  process.exit(1);
}

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bts_dev';

function upcase(s){ return String(s||'').trim().toUpperCase(); }

async function main() {
  await mongoose.connect(MONGO_URI, { autoIndex: true });
  const pts = await PriceTable.find({ seasonCode }).lean();

  let upserts = 0;
  const tariffSet = new Map();

  for (const pt of pts) {
    const zoneKey = pt.zoneKey || '*';
    for (const p of (pt.prices || [])) {
      const code = upcase(p.code);
      const label = p.label || code;
      const priceCents = Number(p.amountCents || 0);
      if (!code || !priceCents) continue;

      // upsert TariffPrice
      const r = await TariffPrice.updateOne(
        { seasonCode, venueSlug, zoneKey, tariffCode: code },
        { $set: { seasonCode, venueSlug, zoneKey, tariffCode: code, priceCents } },
        { upsert: true }
      );
      if (r.upsertedCount) upserts++;

      // collect Tariff
      if (!tariffSet.has(code)) {
        tariffSet.set(code, {
          code,
          label,
          requiresField: p.requiresJustification ? 'justif' : null,
          fieldLabel: p.requiresJustification ? (p.label || 'Justificatif') : null,
          requiresInfo: null,
          active: true,
          sortOrder: 100
        });
      }
    }
  }

  // upsert Tariff catalog
  for (const t of tariffSet.values()) {
    await Tariff.updateOne({ code: t.code }, { $set: t }, { upsert: true });
  }

  console.log(`✔ Migré PriceTable -> TariffPrice (${upserts} upserts), Tariff catalog size=${tariffSet.size}`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
