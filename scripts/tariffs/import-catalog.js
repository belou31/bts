// scripts/tariffs/import-catalog.js
// Usage: node scripts/tariffs/import-catalog.js data/tariff_catalog.csv

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import mongoose from 'mongoose';

import { Tariff } from '../../src/models/Tariff.js';

import dotenv from 'dotenv';
dotenv.config();

function parseBool(v, def=true) {
  if (v == null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (['1','true','yes','y','on'].includes(s)) return true;
  if (['0','false','no','n','off'].includes(s)) return false;
  return def;
}

(async () => {
  const [, , csvPath] = process.argv;
  if (!csvPath) {
    console.error('Usage: node scripts/tariffs/import-catalog.js <csvPath>');
    process.exit(1);
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('Missing MONGO_URI'); process.exit(1); }
  await mongoose.connect(uri);

  const full = path.resolve(csvPath);
  if (!fs.existsSync(full)) { console.error('CSV not found:', full); process.exit(1); }

  const rl = readline.createInterface({ input: fs.createReadStream(full, 'utf8'), crlfDelay: Infinity });

  let header = null, upserts = 0;
  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (!header) {
      header = line.split(',').map(h => h.trim().toLowerCase());
      continue;
    }
    // support des champs CSV quotés pour label/fieldLabel/requiresInfo
    // on fait simple: on split basique puis on retire les quotes de début/fin si présentes
    const cells = line.split(',').map(x => x.trim());
    const get = (name) => {
      const idx = header.indexOf(name);
      return idx >= 0 ? cells[idx] || '' : '';
    };
    const unquote = (s) => {
      if (s.startsWith('"') && s.endsWith('"')) return s.slice(1,-1).replace(/""/g,'"');
      return s;
    };

    const code = String(get('code') || '').toUpperCase();
    const label = unquote(get('label'));
    const requiresField = get('requiresfield') || null;
    const fieldLabel = unquote(get('fieldlabel')) || null;
    const requiresInfo = unquote(get('requiresinfo')) || null;
    const active = parseBool(get('active'), true);
    const sortOrder = Number(get('sortorder')) || 100;

    if (!code || !label) { console.warn('SKIP invalid row:', line); continue; }

    await Tariff.findOneAndUpdate(
      { code },
      { $set: { label, requiresField: requiresField || null, fieldLabel, requiresInfo, active, sortOrder } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    upserts++;
  }

  console.log(`Imported/updated ${upserts} tariffs from ${full}`);
  await mongoose.disconnect();
})();
