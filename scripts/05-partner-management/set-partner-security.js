#!/usr/bin/env node
/**
 * Update partner security settings (allowed origins / frame-ancestors).
 *
 * Usage:
 *   node scripts/05-partner-management/set-partner-security.js --slug=<slug> [--allowed-origins=CSV] [--frame-ancestors=CSV]
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
const parseList = (val = '') =>
  aTrim(val)
    ?.split(/[,\s]+/)
    .map(v => v.trim())
    .filter(Boolean) || [];

const slug = getOption('slug');
if (!slug) {
  console.error('Usage: node scripts/05-partner-management/set-partner-security.js --slug=<slug> [--allowed-origins=...] [--frame-ancestors=...]');
  process.exit(1);
}

const allowedOriginsOpt = getOption('allowed-origins');
const frameAncestorsOpt = getOption('frame-ancestors');

if (allowedOriginsOpt === undefined && frameAncestorsOpt === undefined) {
  console.error('Provide at least one of --allowed-origins or --frame-ancestors.');
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
  console.error(`[partner-security] Unable to read ${targetFile}: ${err.message}`);
  process.exit(1);
}

const idx = entries.findIndex(e => (e?.slug || '').toLowerCase() === slug.toLowerCase());
if (idx === -1) {
  console.error(`[partner-security] Partner "${slug}" not found.`);
  process.exit(1);
}

const updated = { ...entries[idx] };
if (allowedOriginsOpt !== undefined) {
  updated.allowedOrigins = parseList(allowedOriginsOpt);
}
if (frameAncestorsOpt !== undefined) {
  updated.frameAncestors = parseList(frameAncestorsOpt);
}

entries[idx] = updated;
fs.writeFileSync(targetFile, JSON.stringify(entries, null, 2), 'utf8');
console.log(`[partner-security] Updated security for "${slug}"`);
