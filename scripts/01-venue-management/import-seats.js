#!/usr/bin/env node
/**
 * Import seats for a venue from an SVG plan, with optional CSV overrides.
 *
 * Usage:
 *   node scripts/01-venue-management/import-seats.js --venue=<slug> [--csv=<path/to/seats.csv>] [--view=<viewSlug>]
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
  console.error('Usage: node scripts/01-venue-management/import-seats.js --venue=<slug> [--csv=<path/to/seats.csv>] [--view=<viewSlug>]');
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

function resolvePlanPath(slug) {
  const canonical = defaultPlanPath(slug);
  if (fs.existsSync(canonical)) return canonical;
  throw new Error(`[import-seats] Aucun plan trouvé pour "${slug}". Assurez-vous que src/public/static/venues/${slug}/plan.svg existe (via register-venue ou copie manuelle).`);
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

function parseMetaString(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const out = {};
  raw.split(';').forEach(pair => {
    const [k, ...rest] = pair.split(':');
    const key = String(k || '').trim();
    if (!key) return;
    const val = rest.join(':').trim();
    out[key] = val;
  });
  return Object.keys(out).length ? out : null;
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
    const meta = parseMetaString(record.meta || record.Meta || record.META);

    map.set(seatId, {
      zoneKey: (record.zoneKey || record.zone || '').trim(),
      row: (record.row || '').trim(),
      number: (record.number || '').trim(),
      svgSelector: (record.svgSelector || '').trim(),
      meta
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
  let csvArg = argv.csv || null;
  if (!csvArg) {
    const candidate = positional.find((value, index) => {
      if (index === 0) return false;
      return !/\.svg$/i.test(value || '');
    });
    if (candidate) csvArg = candidate;
  }
  const seatAttr = DEFAULT_SEAT_ATTR;
  const writePlan = (argv['write-plan'] !== undefined) ? argv['write-plan'] === true : !!csvArg;
  const viewSlug = argv.view || null;
  const planOut = argv['plan-out'] ? resolveInputFile(argv['plan-out']) : null;
  const viewPath = viewSlug
    ? path.resolve(PLAN_ROOT, venueSlug, 'views', `${viewSlug}.svg`)
    : null;

  if (!venueSlug) usage();

  let planPath;
  try {
    planPath = resolvePlanPath(venueSlug);
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
    console.warn(`[import-seats] Aucun élément avec l'attribut ${seatAttr} dans ${planPath}. On tente les sélecteurs CSV le cas échéant.`);
  } else {
    console.log(`[import-seats] Found ${nodes.length} seats in SVG via ${seatAttr} (${planPath})`);
  }

  const nodesBySeatId = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const sid = $(el).attr(seatAttr)?.trim();
    if (!sid) continue;
    if (nodesBySeatId.has(sid)) continue;
    nodesBySeatId.set(sid, el);
  }

  const seatIds = new Set([
    ...nodesBySeatId.keys(),
    ...(csvOverrides ? Array.from(csvOverrides.map.keys()) : [])
  ]);

  if (seatIds.size === 0) {
    console.error('[import-seats] Aucun siège détecté (ni via attribut, ni via CSV).');
    await mongoose.disconnect();
    process.exit(1);
  }

  const seenSeats = new Set();
  const seatInfoMap = new Map();
  let upserts = 0;

  for (const seatId of seatIds) {
    if (!seatId) continue;
    if (seenSeats.has(seatId)) continue;
    seenSeats.add(seatId);

    const override = csvOverrides?.map.get(seatId);
    let el = nodesBySeatId.get(seatId) || null;
    let selectorUsed = override?.svgSelector || null;
    if (!el && selectorUsed) {
      const found = $(selectorUsed);
      if (found.length > 0) {
        el = found[0];
      }
    }

    if (!el) {
      console.warn(`[import-seats] Seat ${seatId}: introuvable dans le SVG (ajoutez ${seatAttr} ou un svgSelector valide dans le CSV).`);
      continue;
    }

    const zoneAttr = $(el).attr('data-zone')?.trim();
    const inferredZone = override?.zoneKey || zoneAttr || (seatId.split('-')[0] || '').trim();
    const zoneKey = (inferredZone || '').toUpperCase();
    if (!zoneKey) {
      console.warn(`[import-seats] Seat ${seatId}: zoneKey introuvable (ajoutez data-zone, prefixe ou CSV).`);
      continue;
    }

    const row = override?.row || $(el).attr('data-row')?.trim() || '';
    const number = override?.number || $(el).attr('data-number')?.trim() || '';
    const selector = selectorUsed || override?.svgSelector || cssAttrSelector(seatAttr, seatId);
    const meta = override?.meta || parseMetaString($(el).attr('data-seat-meta')) || null;

    // Ajoute l'attribut data-seat-id dans le SVG si demandé
    if (writePlan && !$(el).attr(seatAttr)) {
      $(el).attr(seatAttr, seatId);
    }
    // Ajoute zone/row/number/meta pour ergonomie (sans écraser si déjà présent)
    if (writePlan) {
      if (!$(el).attr('data-seat-zone') && zoneKey) $(el).attr('data-seat-zone', zoneKey);
      if (!$(el).attr('data-seat-row') && row) $(el).attr('data-seat-row', row);
      if (!$(el).attr('data-seat-number') && number) $(el).attr('data-seat-number', number);
      if (!$(el).attr('data-seat-meta') && meta) $(el).attr('data-seat-meta', Object.entries(meta).map(([k,v]) => `${k}:${v}`).join(';'));
    }

    await SeatCatalog.updateOne(
      { venueSlug, seatId },
      { $set: { zoneKey, row, number, svgSelector: selector, meta } },
      { upsert: true }
    );
    seatInfoMap.set(seatId, { seatId, zoneKey, row, number, meta });
    upserts++;
  }

  if (writePlan) {
    const outPath = planOut || planPath;
    fs.writeFileSync(outPath, $.xml(), 'utf8');
    console.log(`[import-seats] Plan mis à jour avec ${seatAttr} → ${outPath}`);
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

  // Enrich optional view with seat attributes
  if (viewPath) {
    if (fs.existsSync(viewPath)) {
      try {
        const viewSvg = fs.readFileSync(viewPath, 'utf8');
        const $view = load(viewSvg);
        const setIfMissing = (el, attr, value) => {
          if (!value) return;
          if ($view(el).attr(attr)) return;
          $view(el).attr(attr, value);
        };
        for (const seatId of seenSeats) {
          const seatData = seatInfoMap.get(seatId);
          if (!seatData) continue;
          let el = $view(`[${seatAttr}="${seatId}"]`).get(0);
          if (!el) el = $view(`[data-seat-id="${seatId}"]`).get(0);
          if (!el) el = $view(`#${seatId.replace(/([\\.])/g, '\\$1')}`).get(0);
          if (!el) continue;
          setIfMissing(el, 'data-seat-id', seatId);
          setIfMissing(el, 'data-seat-zone', seatData.zoneKey || '');
          setIfMissing(el, 'data-seat-row', seatData.row || '');
          setIfMissing(el, 'data-seat-number', seatData.number || '');
          const metaStr = seatData.meta && Object.keys(seatData.meta).length
            ? Object.entries(seatData.meta).map(([k, v]) => `${k}:${v}`).join(';')
            : '';
          setIfMissing(el, 'data-seat-meta', metaStr);
        }
        fs.writeFileSync(viewPath, $view.xml(), 'utf8');
        console.log(`[import-seats] Vue "${viewSlug}" enrichie avec les attributs sièges → ${viewPath}`);
      } catch (err) {
        console.warn(`[import-seats] Impossible d'enrichir la vue ${viewSlug}: ${err?.message || err}`);
      }
    } else {
      console.warn(`[import-seats] Vue ${viewSlug} introuvable à ${viewPath}`);
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
