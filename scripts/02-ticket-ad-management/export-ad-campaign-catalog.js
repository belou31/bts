#!/usr/bin/env node
// scripts/02-ticket-ad-management/export-ad-campaign-catalog.js
// Usage: node scripts/02-ticket-ad-management/export-ad-campaign-catalog.js <catalogSlug> [--venue=<slug>] [--out=<file.csv>]

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

import { AdCampaignCatalog } from '../../src/models/AdCampaignCatalog.js';

import dotenv from 'dotenv';
dotenv.config();

function optionValue(argv, name) {
  const prefix = `--${name}=`;
  const found = argv.find(token => token.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

(async () => {
  const argv = process.argv.slice(2);
  const catalogSlug = argv[0];
  if (!catalogSlug || catalogSlug.startsWith('--')) {
    console.error('Usage: node scripts/02-ticket-ad-management/export-ad-campaign-catalog.js <catalogSlug> [--venue=<slug>] [--out=<file.csv>]');
    process.exit(1);
  }
  const venue = optionValue(argv, 'venue') || null;
  const out = optionValue(argv, 'out') || `ad-campaign-catalog-${catalogSlug}.csv`;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('Missing MONGO_URI'); process.exit(1); }
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  const docs = await AdCampaignCatalog.find({ catalogSlug, venueSlug: venue }).sort({ slot: 1, priority: -1, campaignSlug: 1 }).lean();

  const header = 'campaignSlug,contentType,slot,qrValue,text,tariffCode,zoneKey,zoneType,priority,startsAt,endsAt,active\n';
  const isoOrEmpty = (d) => (d ? new Date(d).toISOString() : '');
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const body = docs.map(d => [
    d.campaignSlug,
    d.contentType,
    d.slot,
    esc(d.qrValue || ''),
    esc(d.text || ''),
    d.tariffCode || '',
    d.zoneKey || '',
    d.zoneType || '',
    Number.isFinite(d.priority) ? d.priority : 100,
    isoOrEmpty(d.startsAt),
    isoOrEmpty(d.endsAt),
    d.active ? 'true' : 'false'
  ].join(',')).join('\n') + (docs.length ? '\n' : '');

  const OUTPUT_DIR = path.resolve(process.cwd(), 'data/outputs');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const full = path.isAbsolute(out) ? out : path.join(OUTPUT_DIR, out);
  fs.writeFileSync(full, header + body, 'utf8');
  console.log(`Exported ${docs.length} ad campaign entries (catalog="${catalogSlug}", venue="${venue || '∅'}") -> ${full}`);
  await mongoose.disconnect();
})();
