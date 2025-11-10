/**
 * Import the tariff catalog from CSV.
 *
 * Usage:
 *   node scripts/02-tariff-management/import-tariffs.js <path/to/tariff_catalog.csv>
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 *   - MONGODB_DB (optional database name)
 *
 * Templates:
 *   - data/templates/csv/tariff-catalog.template.csv
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import mongoose from 'mongoose';

import { Tariff } from '../../src/models/Tariff.js';
import { serializeChannelList } from '../../src/utils/channel-scopes.js';

import dotenv from 'dotenv';
dotenv.config();

const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');

function resolveInputFile(p) {
  if (!p) return p;
  const absolute = path.resolve(p);
  if (fs.existsSync(absolute)) return absolute;
  const fromInputs = path.resolve(INPUT_DIR, p);
  if (fs.existsSync(fromInputs)) return fromInputs;
  return absolute;
}

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
    console.error('Usage: node scripts/02-tariff-management/import-tariffs.js <csvPath>');
   process.exit(1);
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('Missing MONGO_URI/MONGODB_URI'); process.exit(1); }
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  const full = resolveInputFile(csvPath);
  if (!fs.existsSync(full)) { console.error('CSV not found:', csvPath, '(cherche aussi dans data/inputs)'); process.exit(1); }

  const rl = readline.createInterface({ input: fs.createReadStream(full, 'utf8'), crlfDelay: Infinity });

  let header = null, upserts = 0, hasChannelsColumn = false;
  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (!header) {
      header = line.split(',').map(h => h.trim().toLowerCase());
      hasChannelsColumn = header.includes('channels') || header.includes('channel');
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

    const channelsInput = hasChannelsColumn ? (get('channels') || get('channel')) : null;
    const parsedChannels = hasChannelsColumn ? serializeChannelList(channelsInput || '') : undefined;

    const setDoc = { label, requiresField: requiresField || null, fieldLabel, requiresInfo, active, sortOrder };
    const updateDoc = { $set: setDoc };
    if (hasChannelsColumn) {
      if (parsedChannels && parsedChannels.length) {
        setDoc.channels = parsedChannels;
      } else {
        updateDoc.$unset = { channels: '' };
      }
    }

    await Tariff.findOneAndUpdate(
      { code },
      updateDoc,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    upserts++;
  }

  console.log(`Imported/updated ${upserts} tariffs from ${full}`);
  await mongoose.disconnect();
})();
