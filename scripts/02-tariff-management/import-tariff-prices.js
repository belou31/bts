#!/usr/bin/env node
/**
 * Import tariff prices (list or matrix) into a reusable catalog.
 *
 * Usage:
 *   node scripts/02-tariff-management/import-tariff-prices.js <catalogSlug> <csvPath>
 *     [--venue=<slug>] [--format=list|matrix] [--delimiter=,|;] [--append] [--dry-run]
 *
 * Supported CSV formats:
 *   LIST   : zoneKey,tariffCode,priceCents|priceEuro
 *   MATRIX : first column tariffCode, subsequent columns zone keys
 *
 * Notes:
 *   - By default the script clears the existing catalog entries (same slug/venue) before import.
 *     Use --append to upsert without clearing.
 *   - Prices can be expressed in cents (18000) or euros (180,00 / 180.00).
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import mongoose from 'mongoose';

import dotenv from 'dotenv';
dotenv.config();

import { Tariff } from '../../src/models/Tariff.js';
import { TariffPriceCatalog } from '../../src/models/TariffPriceCatalog.js';

const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');

function usage() {
  console.error('Usage: node scripts/02-tariff-management/import-tariff-prices.js <catalogSlug> <csvPath> [--venue=<slug>] [--format=list|matrix] [--delimiter=,|;] [--append] [--dry-run]');
  process.exit(1);
}

function resolveInputFile(p) {
  if (!p) return p;
  const absolute = path.resolve(p);
  if (fs.existsSync(absolute)) return absolute;
  const fromInputs = path.resolve(INPUT_DIR, p);
  if (fs.existsSync(fromInputs)) return fromInputs;
  return absolute;
}

function optionValue(argv, name) {
  const prefix = `--${name}=`;
  const found = argv.find(token => token.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function stripBOM(s) {
  if (!s) return s;
  return s.replace(/^\uFEFF/, '');
}

function detectDelimiter(line, explicit) {
  if (explicit === ',' || explicit === ';') return explicit;
  let comma = 0;
  let semi = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === ',') comma++;
      else if (ch === ';') semi++;
    }
  }
  return semi > comma ? ';' : ',';
}

function parseCSVLine(line, delim) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseEuroToCents(s) {
  if (s == null || s === '') return null;
  const cleaned = String(s).trim().replace(/\s/g, '').replace(',', '.');
  const n = Number(cleaned);
  if (Number.isFinite(n)) return Math.round(n * 100);
  return null;
}

function parsePriceCell(val) {
  if (val == null) return null;
  const sv = String(val).trim();
  if (!sv) return null;
  if (/^\d+$/.test(sv) && Number(sv) > 999) return Number(sv);
  const cents = parseEuroToCents(sv);
  return Number.isFinite(cents) ? cents : null;
}

function headersLC(arr) {
  return arr.map(h => stripBOM(h).trim().toLowerCase());
}

function detectFormat(hdrLC, explicit) {
  if (explicit === 'list' || explicit === 'matrix') return explicit;
  const first = hdrLC[0] || '';
  const hasListSig =
    hdrLC.includes('zonekey') ||
    hdrLC.includes('zone') ||
    hdrLC.includes('pricecents') ||
    hdrLC.includes('priceeuro') ||
    hdrLC.includes('prix') ||
    hdrLC.includes('prix_euro');

  if (hasListSig) return 'list';
  if (['tariffcode', 'code', 'tariff'].includes(first)) return 'matrix';
  const hasTariffFirst = ['tariffcode', 'code', 'tariff'].some(k => hdrLC.includes(k));
  if (hasTariffFirst) return 'matrix';
  return null;
}

async function loadEntriesFromCsv(resolvedCsv, delimiter, explicitFormat) {
  console.log(`[import-tariff-prices] Streaming CSV from ${resolvedCsv}`);
  const rl = readline.createInterface({
    input: fs.createReadStream(resolvedCsv, 'utf8'),
    crlfDelay: Infinity
  });
  rl.on('error', (err) => {
    console.error('[import-tariff-prices] CSV stream error:', err?.message || err);
  });

  const headerInfo = { header: null, headerLC: null, mode: null };
  const entries = [];
  let rowCount = 0;
  let skips = 0;

  for await (const rawLine0 of rl) {
    const rawLine = rawLine0.replace(/\r$/, '');
    if (!rawLine.trim()) continue;

    if (!headerInfo.header) {
      headerInfo.header = parseCSVLine(rawLine, delimiter).map(stripBOM);
      headerInfo.headerLC = headersLC(headerInfo.header);
      headerInfo.mode = detectFormat(headerInfo.headerLC, explicitFormat);
      if (!headerInfo.mode) {
        throw new Error(`Impossible de détecter le format CSV. En-têtes: ${headerInfo.header.join(' | ')}`);
      }
      console.log(`[import-tariff-prices] header columns = ${headerInfo.header.join(', ')}`);
      console.log(`[import-tariff-prices] format=${headerInfo.mode}`);
      continue;
    }

    const cells = parseCSVLine(rawLine, delimiter);
    rowCount++;

    if (headerInfo.mode === 'list') {
      const map = Object.fromEntries(headerInfo.headerLC.map((name, idx) => [name, cells[idx]]));
      const zoneKey = String(map.zonekey || map.zone || '').trim().toUpperCase();
      const tariffCode = String(map.tariffcode || map.code || '').trim().toUpperCase();
      const rawPrice = map.pricecents || map.priceeuro || map.prix || map.prix_euro || map.price;
      const priceCents = parsePriceCell(rawPrice);
      if (!zoneKey || !tariffCode || !Number.isFinite(priceCents)) {
        console.warn(`[import-tariff-prices] Ligne ${rowCount}: données incomplètes (zone=${zoneKey}, tarif=${tariffCode}, prix=${rawPrice}) → ignorée`);
        skips++;
        continue;
      }
      entries.push({ zoneKey, tariffCode, priceCents });
    } else {
      const hdr = headerInfo.header;
      const tariffCode = String(stripBOM(cells[0] || '')).trim().toUpperCase();
      if (!tariffCode) {
        console.warn(`[import-tariff-prices] Ligne ${rowCount}: Tarif vide → ignoré`);
        skips++;
        continue;
      }
      for (let idx = 1; idx < hdr.length; idx++) {
        const zoneKey = String(stripBOM(hdr[idx] || '')).trim().toUpperCase();
        if (!zoneKey) continue;
        const priceCents = parsePriceCell(cells[idx]);
        if (!Number.isFinite(priceCents)) continue;
        entries.push({ zoneKey, tariffCode, priceCents });
      }
    }
  }

  return {
    entries,
    rowCount,
    skips,
    format: headerInfo.mode,
    header: headerInfo.header
  };
}

(async () => {
  const argv = process.argv.slice(2);
  const catalogSlugRaw = argv[0];
  const csvPath = argv[1];
  if (!catalogSlugRaw || !csvPath) usage();

  const catalogSlug = String(catalogSlugRaw).trim().toLowerCase();
  if (!catalogSlug) usage();

  const venueOpt = optionValue(argv, 'venue');
  const explicitFormat = optionValue(argv, 'format');
  const explicitDelim = optionValue(argv, 'delimiter');
  const append = hasFlag(argv, 'append');
  const dryRun = hasFlag(argv, 'dry-run');
  const serialWrites = hasFlag(argv, 'serial') || hasFlag(argv, 'no-bulk');

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGO_URI (ou MONGODB_URI) manquant dans l’environnement');
    process.exit(1);
  }
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(mongoUri, connectOpts);

  const resolvedCsv = resolveInputFile(csvPath);
  if (!fs.existsSync(resolvedCsv)) {
    console.error(`CSV introuvable: ${csvPath} (cherché aussi dans data/inputs)`);
    process.exit(1);
  }

  const firstLine = fs.readFileSync(resolvedCsv, 'utf8').split(/\r?\n/).find(l => l.trim().length);
  if (!firstLine) {
    console.error('CSV vide ou invalide');
    process.exit(1);
  }
  const delimiter = detectDelimiter(firstLine, explicitDelim);
  console.log(`[import-tariff-prices] delimiter="${delimiter}"`);

  let parseResult;
  try {
    parseResult = await loadEntriesFromCsv(resolvedCsv, delimiter, explicitFormat);
  } catch (err) {
    console.error('[import-tariff-prices] Erreur lecture CSV:', err?.message || err);
    await mongoose.disconnect();
    process.exit(1);
  }
  const { entries, rowCount, skips } = parseResult;
  console.log(`[import-tariff-prices] Parsed rows=${rowCount} entries=${entries.length} skips=${skips}`);

  if (!entries.length) {
    console.error('[import-tariff-prices] Aucune donnée exploitable.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // Tariff consistency check
  const uniqueTariffs = [...new Set(entries.map(e => e.tariffCode))];
  console.time('[import-tariff-prices] load-known-tariffs');
  const knownTariffs = await Tariff.find({ code: { $in: uniqueTariffs } }).select({ code: 1 }).lean();
  console.timeEnd('[import-tariff-prices] load-known-tariffs');
  const knownSet = new Set(knownTariffs.map(t => t.code));
  const missingTariffs = uniqueTariffs.filter(code => !knownSet.has(code));
  if (missingTariffs.length) {
    console.warn(`[import-tariff-prices] Attention: ${missingTariffs.length} tarifs absents du catalogue Tariff: ${missingTariffs.join(', ')}`);
  }

  const venueSlug = venueOpt ? String(venueOpt).trim() || null : null;

  if (dryRun) {
    console.log('[import-tariff-prices] Dry-run terminé. Aucun write effectué.');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!append) {
    console.time('[import-tariff-prices] deleteMany');
    const delRes = await TariffPriceCatalog.deleteMany({ catalogSlug, venueSlug });
    console.log(`[import-tariff-prices] Cleared ${delRes.deletedCount} existing entries for catalog="${catalogSlug}" venue="${venueSlug || '∅'}"`);
    console.timeEnd('[import-tariff-prices] deleteMany');
  }

  let upserts = 0;
  if (serialWrites) {
    console.log(`[import-tariff-prices] Serial write mode (${entries.length} updates)`);
    console.time('[import-tariff-prices] serial-writes');
    for (const entry of entries) {
      const res = await TariffPriceCatalog.updateOne(
        {
          catalogSlug,
          venueSlug,
          zoneKey: entry.zoneKey,
          tariffCode: entry.tariffCode
        },
        {
          $set: {
            catalogSlug,
            venueSlug,
            zoneKey: entry.zoneKey,
            tariffCode: entry.tariffCode,
            priceCents: entry.priceCents,
            currency: 'EUR'
          }
        },
        { upsert: true }
      );
      if ((res.upsertedCount ?? 0) > 0 || (res.modifiedCount ?? 0) > 0) upserts++;
    }
    console.timeEnd('[import-tariff-prices] serial-writes');
  } else {
    const bulkOps = entries.map(entry => ({
      updateOne: {
        filter: {
          catalogSlug,
          venueSlug,
          zoneKey: entry.zoneKey,
          tariffCode: entry.tariffCode
        },
        update: {
          $set: {
            catalogSlug,
            venueSlug,
            zoneKey: entry.zoneKey,
            tariffCode: entry.tariffCode,
            priceCents: entry.priceCents,
            currency: 'EUR'
          }
        },
        upsert: true
      }
    }));

    console.time('[import-tariff-prices] bulk-write');
    const bulkRes = await TariffPriceCatalog.bulkWrite(bulkOps, { ordered: false });
    console.timeEnd('[import-tariff-prices] bulk-write');
    upserts = (bulkRes.upsertedCount || 0) + (bulkRes.modifiedCount || 0);
  }
  console.log(`[import-tariff-prices] Upserts=${upserts} (catalog="${catalogSlug}", venue="${venueSlug || '∅'}")`);

  await mongoose.disconnect();
  process.exit(0);
})().catch(async err => {
  console.error('[import-tariff-prices] Erreur:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
