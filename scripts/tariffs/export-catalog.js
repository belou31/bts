// scripts/tariffs/export-catalog.js
// Usage: node scripts/tariffs/export-catalog.js [--out=tariff_catalog.csv]

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

import { Tariff } from '../../src/models/Tariff.js';

import dotenv from 'dotenv';
dotenv.config();


(async () => {
  const outArg = (process.argv.slice(2).find(a => a.startsWith('--out=')) || '--out=tariff_catalog.csv');
  const out = outArg.split('=')[1];

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('Missing MONGO_URI'); process.exit(1); }
  await mongoose.connect(uri);

  const docs = await Tariff.find({}).sort({ sortOrder: 1, label: 1 }).lean();
  const header = 'code,label,requiresField,fieldLabel,requiresInfo,active,sortOrder\n';
  const body = docs.map(d => {
    const esc = s => `"${String(s || '').replace(/"/g,'""')}"`;
    return [
      d.code,
      esc(d.label),
      d.requiresField || '',
      esc(d.fieldLabel || ''),
      esc(d.requiresInfo || ''),
      d.active ? 'true' : 'false',
      Number.isFinite(d.sortOrder) ? d.sortOrder : 100
    ].join(',');
  }).join('\n') + '\n';

  const full = path.resolve(out);
  fs.writeFileSync(full, header + body, 'utf8');
  console.log(`Exported ${docs.length} tariffs -> ${full}`);
  await mongoose.disconnect();
})();
