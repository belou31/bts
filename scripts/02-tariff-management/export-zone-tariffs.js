/**
 * Export zone tariffs to CSV.
 *
 * Usage:
 *   node scripts/02-tariff-management/export-zone-tariffs.js <seasonCode> <venueSlug> [--out=prices.csv]
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 *   - MONGODB_DB (optional database name)
 *
 * Template:
 */

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

import { TariffPrice } from '../../src/models/TariffPrice.js';

import dotenv from 'dotenv';
dotenv.config();


function euro(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

(async () => {
  const [,, seasonCode, venueSlug, ...rest] = process.argv;
  if (!seasonCode || !venueSlug) {
    console.error('Usage: node scripts/02-tariff-management/export-zone-tariffs.js <seasonCode> <venueSlug> [--out=prices.csv]');
    process.exit(1);
  }
  const outArg = rest.find(x => x.startsWith('--out='));
  const outName = (outArg ? outArg.split('=')[1] : `prices-${seasonCode}-${venueSlug}.csv`) || `prices-${seasonCode}-${venueSlug}.csv`;
  const OUTPUT_DIR = path.resolve(process.cwd(), 'data/outputs');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.isAbsolute(outName) ? outName : path.join(OUTPUT_DIR, outName);

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) { console.error('Missing MONGO_URI/MONGODB_URI'); process.exit(1); }
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(mongoUri, connectOpts);

  const docs = await TariffPrice.find({ seasonCode, venueSlug }).lean();
  docs.sort((a,b) => (a.zoneKey||'').localeCompare(b.zoneKey||'') || (a.tariffCode||'').localeCompare(b.tariffCode||''));

  const header = 'zoneKey,tariffCode,priceCents,priceEuro,partnerPriceCents,partnerPriceEuro,currency\n';
  const body = docs.map(d => {
    const ppc = Number(d.partnerPriceCents);
    const currency = d.currency || 'EUR';
    return [
      d.zoneKey,
      d.tariffCode,
      d.priceCents,
      euro(d.priceCents),
      Number.isFinite(ppc) ? ppc : '',
      Number.isFinite(ppc) ? euro(ppc) : '',
      currency
    ].join(',');
  }).join('\n') + '\n';

  fs.writeFileSync(outPath, header + body, 'utf8');
  console.log(`Exported ${docs.length} rows -> ${outPath}`);
  await mongoose.disconnect();
})();
