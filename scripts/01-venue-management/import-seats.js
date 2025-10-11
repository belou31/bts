#!/usr/bin/env node
/**
 * Import seats for a venue from an SVG plan, with optional CSV overrides.
 *
 * Usage:
 *   node scripts/01-venue-management/import-seats.js --venue=<slug> [--csv=<path/to/seats.csv>] [--attr=data-seat-id] [--plan=<override.svg>]
 *
 * Behaviour:
 *   - Reads every element marked with data-seat-id inside the SVG file.
 *   - Derives zone/row/number from SVG attributes (data-zone/data-row/data-number) or from CSV overrides.
 *   - Upserts SeatCatalog entries (venueSlug + seatId).
 *   - When a CSV is provided, validates that every listed seat exists in the SVG.
 */

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { load } from 'cheerio';
import dotenv from 'dotenv';

import { SeatCatalog } from '../../src/models/SeatCatalog.js';

dotenv.config();

const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');
const DEFAULT_SEAT_ATTR = 'data-seat-id';
const PLAN_ROOT = path.resolve(process.cwd(), 'src/public/static/venues');

function usage() {
  console.error('Usage: node scripts/01-venue-management/import-seats.js --venue=<slug> [--csv=<path/to/seats.csv>] [--attr=data-seat-id] [--plan=<override.svg>]');
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

function defaultPlanPath(slug) {
  return path.resolve(PLAN_ROOT, slug, 'plan.svg');
}

function resolvePlanPath(slug, override) {
  if (override) {
    const resolved = resolveInputFile(override);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`[import-seats] Plan introuvable: ${override} (cherché aussi dans data/inputs)`);
  }
  const canonical = defaultPlanPath(slug);
  if (fs.existsSync(canonical)) return canonical;
  throw new Error(`[import-seats] Aucun plan trouvé pour "${slug}". Exécutez register-venue ou fournissez --plan=<path/to/plan.svg>.`);
}

function parseArgv(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        const key = token.slice(2, eq);
        const value = token.slice(eq + 1);
        args[key] = value;
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          args[key] = next;
          i++;
        } else {
          args[key] = true;
        }
      }
    } else {
      args.positional.push(token);
    }
  }
  return args;
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result.map(cell => cell.replace(/\r$/, ''));
}

function readSeatsCsv(csvPath) {
  const map = new Map();
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split(/\n/);
  let header = null;
  let dataRows = 0;

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const columns = splitCsvLine(rawLine);
    if (!header) {
      header = columns.map(col => col.trim());
      return;
    }
    const record = {};
    header.forEach((key, i) => {
      const normalized = key.trim();
      if (!normalized) return;
      record[normalized] = (columns[i] ?? '').trim();
    });

    const seatId = (record.seatId || record.SeatId || record.id || record.seat || '').trim();
    if (!seatId) {
      console.warn(`[import-seats] Ligne ${idx + 1}: seatId manquant, ligne ignorée.`);
      return;
    }
    dataRows++;
    map.set(seatId, {
      zoneKey: (record.zoneKey || record.zone || '').trim(),
      row: (record.row || '').trim(),
      number: (record.number || '').trim(),
      svgSelector: (record.svgSelector || '').trim()
    });
  });

  return { map, rows: dataRows };
}

function cssAttrSelector(attr, value) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[${attr}="${escaped}"]`;
}

(async () => {
  const argv = parseArgv(process.argv.slice(2));
  const positional = argv.positional || [];
  const venueSlug = argv.venue || positional[0];
  let planOverride = argv.svg || argv.plan || null;
  let csvArg = argv.csv || null;
  if (!planOverride && positional.length >= 2 && /\.svg$/i.test(positional[1] || '')) {
    planOverride = positional[1];
  }
  if (!csvArg) {
    const candidate = positional.find((value, index) => {
      if (index === 0) return false;
      if (planOverride && value === planOverride) return false;
      return !/\.svg$/i.test(value || '');
    });
    if (candidate) csvArg = candidate;
  }
  const seatAttr = argv.attr || DEFAULT_SEAT_ATTR;

  if (!venueSlug) usage();

  let planPath;
  try {
    planPath = resolvePlanPath(venueSlug, planOverride);
  } catch (err) {
    console.error(err?.message || err);
    process.exit(1);
  }

  let csvOverrides = null;
  if (csvArg) {
    const resolvedCsv = resolveInputFile(csvArg);
    if (!fs.existsSync(resolvedCsv)) {
      console.error(`[import-seats] CSV introuvable: ${csvArg} (cherché aussi dans data/inputs)`);
      process.exit(1);
    }
    csvOverrides = readSeatsCsv(resolvedCsv);
    console.log(`[import-seats] Overrides CSV: ${resolvedCsv} (lignes=${csvOverrides.rows})`);
  }

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('[import-seats] MONGO_URI (ou MONGODB_URI) manquant dans l\'environnement');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const svg = fs.readFileSync(planPath, 'utf8');
  const $ = load(svg);
  const nodes = $(`[${seatAttr}]`);
  if (nodes.length === 0) {
    console.error(`[import-seats] Aucun élément avec l'attribut ${seatAttr} dans ${planPath}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`[import-seats] Found ${nodes.length} seats in SVG (${planPath})`);

  const seenSeats = new Set();
  let upserts = 0;

  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const seatId = $(el).attr(seatAttr)?.trim();
    if (!seatId) continue;
    if (seenSeats.has(seatId)) continue;
    seenSeats.add(seatId);

    const override = csvOverrides?.map.get(seatId);
    const zoneAttr = $(el).attr('data-zone')?.trim();
    const inferredZone = override?.zoneKey || zoneAttr || (seatId.split('-')[0] || '').trim();
    const zoneKey = (inferredZone || '').toUpperCase();
    if (!zoneKey) {
      console.warn(`[import-seats] Seat ${seatId}: zoneKey introuvable (ajoutez data-zone, prefixe ou CSV).`);
      continue;
    }

    const row = override?.row || $(el).attr('data-row')?.trim() || '';
    const number = override?.number || $(el).attr('data-number')?.trim() || '';
    const selector = override?.svgSelector || cssAttrSelector(seatAttr, seatId);

    await SeatCatalog.updateOne(
      { venueSlug, seatId },
      { $set: { zoneKey, row, number, svgSelector: selector } },
      { upsert: true }
    );
    upserts++;
  }

  if (csvOverrides) {
    const missing = [];
    for (const seatId of csvOverrides.map.keys()) {
      if (!seenSeats.has(seatId)) {
        missing.push(seatId);
      }
    }
    if (missing.length) {
      console.warn(`[import-seats] ${missing.length} sièges listés dans le CSV n'ont pas été trouvés dans le SVG: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`);
    }
  }

  console.log(`✅ Seats upserted: ${upserts} (venue=${venueSlug})`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('[import-seats] Erreur:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
