/**
 * Import the tariff catalog from CSV.
 *
 * Usage:
 *   node scripts/02-tariff-management/import-tariffs.js <path/to/tariff_catalog.csv> [--dry-run]
 *
 * Colonnes : code,label (obligatoires) ; requiresField, fieldLabel,
 * requiresInfo, sortOrder (défaut 100), active (défaut true), channels.
 * Colonne channels absente : canaux inchangés ; présente mais vide : canaux
 * retirés (tarif public).
 *
 * Ne touche QUE les tarifs globaux (priceTableKey null) : les copies d'un
 * tarif dans la table de prix d'un événement ne sont jamais modifiées.
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 *   - MONGODB_DB (optional database name)
 *
 * Templates:
 *   - data_references/csv/tariff-catalog.template.csv
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import mongoose from 'mongoose';

import { Tariff } from '../../src/models/Tariff.js';
import { serializeChannelList } from '../../src/utils/channel-scopes.js';
import { splitCsvLine, detectCsvDelimiter } from '../../src/utils/csv-line.js';

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

// « false », « no », « 0 » ou vide : pas de valeur. Ces mots étaient
// enregistrés tels quels — la page de commande affichait alors « false » comme
// texte d'information sous la ligne.
function textOrNull(v) {
  const s = String(v ?? '').trim();
  return (!s || ['false', 'no', 'non', '0', 'null'].includes(s.toLowerCase())) ? null : s;
}

function parseBool(v, def=true) {
  if (v == null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (['1','true','yes','y','on'].includes(s)) return true;
  if (['0','false','no','n','off'].includes(s)) return false;
  return def;
}

(async () => {
  const csvPath = process.argv.slice(2).find(a => !a.startsWith('--'));
  const dryRun = process.argv.includes('--dry-run');
  if (!csvPath) {
    console.error('Usage: node scripts/02-tariff-management/import-tariffs.js <csvPath> [--dry-run]');
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

  let header = null, delimiter = ',', hasChannelsColumn = false;
  const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!header) {
      delimiter = detectCsvDelimiter(line);
      header = splitCsvLine(line, delimiter).map(h => h.toLowerCase());
      hasChannelsColumn = header.includes('channels') || header.includes('channel');
      continue;
    }
    const cells = splitCsvLine(line, delimiter);
    const get = (name) => {
      const idx = header.indexOf(name);
      return idx >= 0 ? cells[idx] || '' : '';
    };

    const code = String(get('code') || '').toUpperCase();
    const label = get('label');
    if (!code || !label) { console.warn('SKIP ligne invalide (code et label requis) :', line); counts.skipped++; continue; }

    const rf = textOrNull(get('requiresfield'));
    const setDoc = {
      label,
      // « true »/« yes »/« 1 » → 'true' : seule valeur que la page de commande
      // reconnaît pour exiger un justificatif.
      requiresField: rf && ['true', 'yes', 'oui', '1'].includes(rf.toLowerCase()) ? 'true' : rf,
      fieldLabel: textOrNull(get('fieldlabel')),
      requiresInfo: textOrNull(get('requiresinfo')),
      active: parseBool(get('active'), true),
      sortOrder: Number(get('sortorder')) || 100
    };
    const updateDoc = { $set: setDoc };
    if (hasChannelsColumn) {
      const parsedChannels = serializeChannelList(get('channels') || get('channel') || '');
      if (parsedChannels && parsedChannels.length) setDoc.channels = parsedChannels;
      else updateDoc.$unset = { channels: '' };
    }

    // Le tarif GLOBAL de ce code, jamais une copie d'événement : un filtre sur
    // le seul code pouvait viser la copie d'un match (NORMAL en a une par
    // événement) et laisser le catalogue inchangé.
    const filter = { code, priceTableKey: null };
    const existing = await Tariff.findOne(filter).lean();
    const changed = existing
      ? Object.keys(setDoc).filter(k => JSON.stringify(existing[k] ?? null) !== JSON.stringify(setDoc[k] ?? null))
        .concat(updateDoc.$unset && existing.channels?.length ? ['channels'] : [])
      : null;
    if (existing && !changed.length) { counts.unchanged++; continue; }
    console.log(`${existing ? '~ mis à jour' : '+ créé     '} ${code}${existing ? ' (' + changed.join(', ') + ')' : ''}`);
    if (existing) counts.updated++; else counts.created++;
    if (dryRun) continue;
    await Tariff.findOneAndUpdate(filter, updateDoc, { upsert: true, new: true, setDefaultsOnInsert: true });
  }

  console.log(`${dryRun ? 'Dry-run — ' : ''}créés=${counts.created} mis à jour=${counts.updated} inchangés=${counts.unchanged} ignorés=${counts.skipped} (${full})`);
  await mongoose.disconnect();
})();
