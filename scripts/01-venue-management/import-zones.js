#!/usr/bin/env node
/**
 * Import zones for a venue/season from CSV and/or SVG sources.
 *
 * Usage:
 *   node scripts/01-venue-management/import-zones.js --venue=<slug> [--csv=<path/to/zones.csv>] [--view=<viewSlug>]
 *
 * Behaviour:
 *   - When a CSV is provided, rows are interpreted using zones.template.csv columns.
 *   - When an SVG is available, elements tagged with data-zone-id (or fallback attributes) infer selectors and optional metadata.
 *   - Upserts ZoneCatalog documents per venue; instantiate them later for a season.
 */

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { load } from 'cheerio';
import dotenv from 'dotenv';

import { ZoneCatalog } from '../../src/models/ZoneCatalog.js';

dotenv.config();

const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');
const DEFAULT_ZONE_ATTR = 'data-zone-id';
const FALLBACK_ZONE_ATTRS = ['data-zone-id', 'data-zone-key', 'data-zone'];
const PLAN_ROOT = path.resolve(process.cwd(), 'src/public/static/venues');

function usage() {
  console.error('Usage: node scripts/01-venue-management/import-zones.js --venue=<slug> [--csv=<path/to/zones.csv>] [--view=<viewSlug>]');
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
  return fs.existsSync(canonical) ? canonical : null;
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

function parseBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['false', '0', 'no', 'off', 'inactive', 'disabled'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on', 'active', 'enabled'].includes(normalized)) return true;
  return defaultValue;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function readZonesCsv(csvPath) {
  const map = new Map();
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split(/\n/);
  let header = null;
  let rows = 0;

  lines.forEach((rawLine, idx) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
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
    const keyRaw = record.key || record.zoneKey || record.id || '';
    const key = String(keyRaw || '').trim().toUpperCase();
    if (!key) {
      console.warn(`[import-zones] Ligne ${idx + 1}: key manquant, ligne ignorée.`);
      return;
    }
    rows++;
    map.set(key, {
      name: record.name ? String(record.name).trim() : '',
      type: record.type ? String(record.type).trim().toLowerCase() : '',
      access: record.access ? String(record.access).trim().toUpperCase() : '',
      capacity: toNumber(record.capacity),
      quota: toNumber(record.quota),
      svgSelector: record.svgSelector ? String(record.svgSelector).trim() : '',
      isActive: parseBoolean(record.isActive, true),
      meta: parseMetaString(record.meta || record.Meta || record.META)
    });
  });

  return { map, rows };
}

function cssAttrSelector(attr, value) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[${attr}="${escaped}"]`;
}

function parseSvgZones($, attrs) {
  const zones = new Map();
  const usedAttributes = new Set();

  attrs.forEach(attr => {
    const nodes = $(`[${attr}]`);
    if (!nodes.length) return;
    usedAttributes.add(attr);
    nodes.each((_, el) => {
      const raw = $(el).attr(attr)?.trim();
      if (!raw) return;
      const key = raw.trim().toUpperCase();
      if (!key) return;
      if (!zones.has(key)) {
        zones.set(key, {
          svgSelector: cssAttrSelector(attr, raw.trim()),
          rawValue: raw.trim(),
          attr,
          name: $(el).attr('data-zone-name')?.trim() || '',
          type: $(el).attr('data-zone-type')?.trim().toLowerCase() || '',
          access: $(el).attr('data-zone-access')?.trim().toUpperCase() || '',
          meta: parseMetaString($(el).attr('data-zone-meta')),
          element: el
        });
      }
    });
  });

  return { zones, usedAttributes };
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
  const attr = DEFAULT_ZONE_ATTR;
  const writePlan = (argv['write-plan'] !== undefined) ? argv['write-plan'] === true : !!csvArg;
  const viewSlug = argv.view || null;
  const planOut = argv['plan-out'] ? resolveInputFile(argv['plan-out']) : null;
  const viewPath = viewSlug
    ? path.resolve(PLAN_ROOT, venueSlug, 'views', `${viewSlug}.svg`)
    : null;

  if (!venueSlug) usage();

  const csvPath = csvArg ? resolveInputFile(csvArg) : null;
  let planPath = null;
  let svgDocument = null;
  try {
    planPath = resolvePlanPath(venueSlug);
    if (planPath) {
      const svg = fs.readFileSync(planPath, 'utf8');
      svgDocument = load(svg);
    }
  } catch (err) {
    console.error(err?.message || err);
    process.exit(1);
  }

  if (csvPath && !fs.existsSync(csvPath)) {
    console.error(`[import-zones] CSV introuvable: ${csvArg} (cherché aussi dans data/inputs)`);
    process.exit(1);
  }
  if (!csvPath && !planPath) {
    console.error('[import-zones] Fournissez au moins un CSV ou assurez-vous que le plan SVG du lieu a été enregistré.');
    process.exit(1);
  }

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('[import-zones] MONGO_URI (ou MONGODB_URI) manquant dans l\'environnement');
    process.exit(1);
  }

  const opts = {};
  if (process.env.MONGODB_DB) opts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, opts);

  try {
    const csvData = csvPath ? readZonesCsv(csvPath) : { map: new Map(), rows: 0 };
    if (csvPath) {
      console.log(`[import-zones] CSV détecté: ${csvPath} (lignes=${csvData.rows})`);
    }

    let svgData = { zones: new Map(), usedAttributes: new Set() };
    if (planPath && svgDocument) {
      const attrCandidates = FALLBACK_ZONE_ATTRS;
      svgData = parseSvgZones(svgDocument, attrCandidates);
      if (!svgData.zones.size) {
        if (csvData.rows > 0) {
          console.log(`[import-zones] Aucun élément trouvé via ${attrCandidates.join('/')} (le plan sera enrichi depuis le CSV).`);
        } else {
          console.warn(`[import-zones] Aucun élément trouvé dans ${planPath} avec l'attribut ${attrCandidates.join('/')}`);
        }
      } else {
        console.log(`[import-zones] Zones détectées dans ${planPath} via ${Array.from(svgData.usedAttributes).join(', ')}`);
      }
    }

    const allKeys = new Set([
      ...csvData.map.keys(),
      ...svgData.zones.keys()
    ]);
    if (!allKeys.size) {
      throw new Error('Aucune zone détectée (ni via CSV ni via SVG).');
    }

    const zoneInfoMap = new Map();
    let upserts = 0;
    for (const key of allKeys) {
      const csvZone = csvData.map.get(key);
      const svgZone = svgData.zones.get(key);
      const name = (csvZone?.name || svgZone?.name || key).trim() || key;
      const type = (csvZone?.type || svgZone?.type || 'seated').trim().toLowerCase();
      const access = (csvZone?.access || svgZone?.access || 'PUBLIC').trim().toUpperCase();
      const capacity = csvZone?.capacity ?? 0;
      const quota = csvZone?.quota ?? 0;
      const svgSelector = (csvZone?.svgSelector || svgZone?.svgSelector || '').trim() || null;
      const meta = csvZone?.meta || svgZone?.meta || null;
      const isActive = csvZone ? csvZone.isActive : true;

      if (!svgSelector) {
        console.warn(`[import-zones] Zone ${key}: aucun sélecteur SVG fourni ou détecté.`);
      }

      // Ajoute l'attribut zone sur le plan si demandé
      if (writePlan && svgDocument && svgSelector) {
        const targetAttr = DEFAULT_ZONE_ATTR;
        const el = svgZone?.element || svgDocument(svgSelector).get(0);
        if (el) {
          if (!svgDocument(el).attr(targetAttr)) svgDocument(el).attr(targetAttr, key);
          if (!svgDocument(el).attr('data-zone-name') && name) svgDocument(el).attr('data-zone-name', name);
          if (!svgDocument(el).attr('data-zone-type') && type) svgDocument(el).attr('data-zone-type', type);
          if (!svgDocument(el).attr('data-zone-access') && access) svgDocument(el).attr('data-zone-access', access);
          if (!svgDocument(el).attr('data-zone-meta') && meta) {
            const metaStr = Object.entries(meta).map(([k,v]) => `${k}:${v}`).join(';');
            svgDocument(el).attr('data-zone-meta', metaStr);
          }
        }
      }

      await ZoneCatalog.updateOne(
        { venueSlug, key },
        {
          $set: {
            name,
            type,
            access,
            capacity,
            quota,
            svgSelector,
            venueSlug,
            isActive,
            meta
          }
        },
        { upsert: true }
      );
      zoneInfoMap.set(key, { key, name, type, access, meta });
      upserts++;
    }

    if (csvPath && planPath) {
      const missingInSvg = [...csvData.map.keys()].filter(key => !svgData.zones.has(key));
      if (missingInSvg.length) {
        console.warn(`[import-zones] ${missingInSvg.length} zones listées dans le CSV n'ont pas été trouvées via ${attr}: ${missingInSvg.slice(0, 10).join(', ')}${missingInSvg.length > 10 ? '…' : ''}`);
      }
    }

    // Enrich optional view with zone attributes
    if (viewPath) {
      if (fs.existsSync(viewPath)) {
        try {
          const viewSvg = fs.readFileSync(viewPath, 'utf8');
          const $view = load(viewSvg);
          const setIfMissing = (el, attrName, value) => {
            if (!value) return;
            if ($view(el).attr(attrName)) return;
            $view(el).attr(attrName, value);
          };
          for (const [key, info] of zoneInfoMap.entries()) {
            let el = $view(`[data-zone-id="${key}"]`).get(0);
            if (!el) el = $view(`#${key.replace(/([\\.])/g, '\\$1')}`).get(0);
            if (!el) continue;
            setIfMissing(el, 'data-zone-id', key);
            setIfMissing(el, 'data-zone-name', info.name || '');
            setIfMissing(el, 'data-zone-type', info.type || '');
            setIfMissing(el, 'data-zone-access', info.access || '');
            const metaStr = info.meta && Object.keys(info.meta).length
              ? Object.entries(info.meta).map(([k, v]) => `${k}:${v}`).join(';')
              : '';
            setIfMissing(el, 'data-zone-meta', metaStr);
          }
          fs.writeFileSync(viewPath, $view.xml(), 'utf8');
          console.log(`[import-zones] Vue "${viewSlug}" enrichie avec les attributs zones → ${viewPath}`);
        } catch (err) {
          console.warn(`[import-zones] Impossible d'enrichir la vue ${viewSlug}: ${err?.message || err}`);
        }
      } else {
        console.warn(`[import-zones] Vue ${viewSlug} introuvable à ${viewPath}`);
      }
    }

    console.log(`✅ Zone catalog upserted: ${upserts} entrées (venue=${venueSlug})`);
    if (writePlan && svgDocument && planPath) {
      const outPath = planOut || planPath;
      fs.writeFileSync(outPath, svgDocument.xml(), 'utf8');
      console.log(`[import-zones] Plan mis à jour avec ${attr || DEFAULT_ZONE_ATTR} → ${outPath}`);
    }
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('[import-zones] Erreur:', err);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
