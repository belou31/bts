#!/usr/bin/env node
/**
 * Set a partner pre-sale quota for a specific event.
 *
 * Usage:
 *   node scripts/05-partner-management/set-partner-presale.js --partner=<slug> --event=<eventSlug> --quota=<number>
 *
 * Stores the quota under data/customization/partners.json:
 * {
 *   presale: { events: { "<eventSlug>": { quota: <number> } } }
 * }
 */

import fs from 'fs';
import path from 'path';

function parseArgv(argv) {
  const args = {};
  argv.forEach(tok => {
    const m = tok.match(/^--([^=]+)=(.*)$/);
    if (m) {
      args[m[1]] = m[2];
    }
  });
  return args;
}

const args = parseArgv(process.argv.slice(2));
const partner = (args.partner || args.slug || '').trim().toLowerCase();
const eventSlug = (args.event || '').trim();
const quota = Number(args.quota || args.q || 0);

if (!partner || !eventSlug || !Number.isFinite(quota)) {
  console.error('Usage: --partner=<slug> --event=<eventSlug> --quota=<number>');
  process.exit(1);
}

const file = path.resolve(process.cwd(), 'data', 'customization', 'partners.json');
if (!fs.existsSync(file)) {
  console.error('partners.json not found at', file);
  process.exit(1);
}

const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(parsed)) {
  console.error('partners.json must contain an array.');
  process.exit(1);
}

const idx = parsed.findIndex(p => (p?.slug || '').toLowerCase() === partner);
if (idx === -1) {
  console.error(`Partner "${partner}" not found in partners.json`);
  process.exit(1);
}

const cfg = parsed[idx];
cfg.presale = cfg.presale || {};
cfg.presale.events = cfg.presale.events || {};
cfg.presale.events[eventSlug] = { quota };

parsed[idx] = cfg;
fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
console.log(`Presale quota set: partner=${partner} event=${eventSlug} quota=${quota}`);
