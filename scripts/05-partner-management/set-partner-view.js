#!/usr/bin/env node
/**
 * Update partner venue view (global or scoped).
 *
 * Usage:
 *   node scripts/05-partner-management/set-partner-view.js --slug=<slug> --venue-view=<slug> [--event=<eventSlug>] [--season=<code>]
 */

import fs from 'fs';
import path from 'path';
import process from 'process';

const args = process.argv.slice(2);
const aTrim = v => (v == null ? v : String(v).trim());
const getOption = (name) => {
  const prefix = `--${name}=`;
  const direct = args.find(a => a.startsWith(prefix));
  if (direct) return aTrim(direct.slice(prefix.length));
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1]) return aTrim(args[index + 1]);
  return undefined;
};

const slug = getOption('slug');
if (!slug) {
  console.error('Usage: node scripts/05-partner-management/set-partner-view.js --slug=<slug> --venue-view=<slug> [--event=<eventSlug>] [--season=<code>]');
  process.exit(1);
}

const venueViewOpt = getOption('venue-view');
const eventOpt = getOption('event');
const seasonOpt = getOption('season');

if (venueViewOpt === undefined) {
  console.error('Provide --venue-view to update (optionally scoped with --event or --season).');
  process.exit(1);
}

const targetDir = path.resolve(process.cwd(), 'data', 'customization');
const targetFile = path.join(targetDir, 'partners.json');
if (!fs.existsSync(targetFile)) {
  console.error(`partners.json not found at ${targetFile} (run init-partners.js first).`);
  process.exit(1);
}

let entries = [];
try {
  const raw = fs.readFileSync(targetFile, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) entries = parsed;
} catch (err) {
  console.error(`[partner-view] Unable to read ${targetFile}: ${err.message}`);
  process.exit(1);
}

const idx = entries.findIndex(e => (e?.slug || '').toLowerCase() === slug.toLowerCase());
if (idx === -1) {
  console.error(`[partner-view] Partner "${slug}" not found.`);
  process.exit(1);
}

const updated = { ...entries[idx] };
if (!updated.venueViews) {
  updated.venueViews = { events: {}, seasons: {} };
}
if (eventOpt) {
  updated.venueViews.events = Object.assign({}, updated.venueViews.events || {}, { [eventOpt]: venueViewOpt || null });
} else if (seasonOpt) {
  updated.venueViews.seasons = Object.assign({}, updated.venueViews.seasons || {}, { [seasonOpt]: venueViewOpt || null });
} else {
  updated.venueView = venueViewOpt ? String(venueViewOpt) : null;
}

entries[idx] = updated;
fs.writeFileSync(targetFile, JSON.stringify(entries, null, 2), 'utf8');
console.log(`[partner-view] Updated venue view for "${slug}"${eventOpt ? ` (event=${eventOpt})` : seasonOpt ? ` (season=${seasonOpt})` : ''}`);
