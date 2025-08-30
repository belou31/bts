// scripts/pricing/export-zone-tariffs.js
// Usage:
//   node scripts/pricing/export-zone-tariffs.js <seasonCode> <venueSlug> [--out=prices.csv]

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
    console.error('Usage: node scripts/pricing/export-zone-tariffs.js <seasonCode> <venueSlug> [--out=prices.csv]');
    process.exit(1);
  }
  const outArg = rest.find(x => x.startsWith('--out=')) || '--out=prices.csv';
  const outPath = outArg.split('=')[1];

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) { console.error('Missing MONGO_URI'); process.exit(1); }
  await mongoose.connect(mongoUri);

  const docs = await TariffPrice.find({ seasonCode, venueSlug }).lean();
  docs.sort((a,b) => (a.zoneKey||'').localeCompare(b.zoneKey||'') || (a.tariffCode||'').localeCompare(b.tariffCode||''));

  const header = 'zoneKey,tariffCode,priceCents,priceEuro\n';
  const body = docs.map(d => `${d.zoneKey},${d.tariffCode},${d.priceCents},${euro(d.priceCents)}`).join('\n') + '\n';

  const full = path.resolve(outPath);
  fs.writeFileSync(full, header + body, 'utf8');
  console.log(`Exported ${docs.length} rows -> ${full}`);
  await mongoose.disconnect();
})();
