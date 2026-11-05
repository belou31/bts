#!/usr/bin/env node
/**
 * Import a reusable ad campaign catalog from CSV — WHERE/WHEN existing
 * AdCampaign(s) (by slug, defined via import-ad-campaign-asset.js) show up: which
 * slot, filtered by tariffCode/zoneKey/zoneType.
 *
 * Usage:
 *   node scripts/02-ticket-ad-management/import-ad-campaign-catalog.js <catalogSlug> <csvPath>
 *     [--venue=<slug>] [--append] [--dry-run]
 *
 * Notes:
 *   - By default clears existing AdCampaignCatalog entries for the same
 *     catalogSlug/venue before import. Use --append to upsert without clearing.
 *
 * Templates:
 *   - data_references/csv/ad-campaign-catalog.template.csv
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import mongoose from 'mongoose';

import dotenv from 'dotenv';
dotenv.config();

import { importAdCampaignCatalog } from '../../src/services/importers/adCampaignCatalogImporter.js';
import { AdCampaign } from '../../src/models/AdCampaign.js';

const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');

function usage() {
  console.error('Usage: node scripts/02-ticket-ad-management/import-ad-campaign-catalog.js <catalogSlug> <csvPath> [--venue=<slug>] [--append] [--dry-run]');
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

function parseCSVLine(line) {
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
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

async function loadEntriesFromCsv(resolvedCsv) {
  const rl = readline.createInterface({ input: fs.createReadStream(resolvedCsv, 'utf8'), crlfDelay: Infinity });
  let header = null;
  const entries = [];
  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '').replace(/^﻿/, '');
    if (!line.trim()) continue;
    if (!header) {
      // The header row itself is commented out in this repo's *.template.csv
      // convention (see data_references/csv/tariff-catalog.template.csv) —
      // strip a leading "# " so it's still usable as the real header. Only a
      // "#" line found AFTER the header is a genuine comment to skip.
      header = parseCSVLine(line.replace(/^#\s*/, '')).map(h => h.toLowerCase());
      continue;
    }
    if (line.trim().startsWith('#')) continue;
    const cells = parseCSVLine(line);
    const entry = Object.fromEntries(header.map((name, idx) => [name, cells[idx] ?? '']));
    entries.push(entry);
  }
  return entries;
}

(async () => {
  const argv = process.argv.slice(2);
  const catalogSlug = argv[0];
  const csvPath = argv[1];
  if (!catalogSlug || !csvPath || catalogSlug.startsWith('--')) usage();

  const venue = optionValue(argv, 'venue');
  const append = hasFlag(argv, 'append');
  const dryRun = hasFlag(argv, 'dry-run');

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('Missing MONGO_URI/MONGODB_URI'); process.exit(1); }
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  const full = resolveInputFile(csvPath);
  if (!fs.existsSync(full)) {
    console.error('CSV not found:', csvPath, '(cherche aussi dans data/inputs)');
    await mongoose.disconnect();
    process.exit(1);
  }

  const entries = await loadEntriesFromCsv(full);
  if (!entries.length) {
    console.error('CSV vide ou invalide');
    await mongoose.disconnect();
    process.exit(1);
  }

  try {
    const summary = await importAdCampaignCatalog({
      entries,
      catalogSlug,
      venueSlug: venue || null,
      append,
      dryRun,
      logger: console
    });
    console.log(`✅ catalog="${catalogSlug}" venue="${venue || '∅'}" inserted=${summary.inserted} updated=${summary.updated} unchanged=${summary.unchanged} skipped=${summary.skipped}`);
    if (summary.errors.length) console.warn(summary.errors.join('\n'));

    const uniqueCampaigns = [...new Set(entries.map(e => String(e.campaignslug || e.campaignSlug || '').toLowerCase()).filter(Boolean))];
    const known = await AdCampaign.find({ slug: { $in: uniqueCampaigns } }).select({ slug: 1 }).lean();
    const knownSet = new Set(known.map(c => c.slug));
    const missing = uniqueCampaigns.filter(s => !knownSet.has(s));
    if (missing.length) {
      console.warn(`⚠️  ${missing.length} campagne(s) référencée(s) mais absente(s) d'AdCampaign (voir import-ad-campaign-asset.js): ${missing.join(', ')}`);
    }
  } catch (err) {
    console.error('❌', err.message || err);
    await mongoose.disconnect();
    process.exit(1);
  }

  await mongoose.disconnect();
  process.exit(0);
})();
