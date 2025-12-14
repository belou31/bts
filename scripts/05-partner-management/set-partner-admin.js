#!/usr/bin/env node
/**
 * Set or update partner admin credentials in data/customization/partners.json.
 *
 * Usage:
 *   node scripts/05-partner-management/set-partner-admin.js --partner=<slug> --user=<login> --pass=<password>
 */

import fs from 'fs';
import path from 'path';
import process from 'process';

const args = process.argv.slice(2);
const getOpt = (name) => {
  const prefix = `--${name}=`;
  const found = args.find(a => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return null;
};

const partnerSlug = getOpt('partner') || getOpt('slug');
const user = getOpt('user');
const pass = getOpt('pass');

if (!partnerSlug || !user || !pass) {
  console.error('Usage: node scripts/05-partner-management/set-partner-admin.js --partner=<slug> --user=<login> --pass=<password>');
  process.exit(1);
}

const targetDir = path.resolve(process.cwd(), 'data', 'customization');
const targetFile = path.join(targetDir, 'partners.json');
fs.mkdirSync(targetDir, { recursive: true });

if (!fs.existsSync(targetFile)) {
  console.error(`[partner-admin] ${targetFile} not found. Initialize partners first.`);
  process.exit(1);
}

let entries = [];
try {
  const raw = fs.readFileSync(targetFile, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) entries = parsed;
} catch (err) {
  console.error(`[partner-admin] Unable to read ${targetFile}: ${err.message}`);
  process.exit(1);
}

const idx = entries.findIndex(e => (e?.slug || '').toLowerCase() === partnerSlug.toLowerCase());
if (idx === -1) {
  console.error(`[partner-admin] partner "${partnerSlug}" not found in ${targetFile}`);
  process.exit(1);
}

const entry = entries[idx] || {};
entry.admin = { user, pass };
entries[idx] = entry;

fs.writeFileSync(targetFile, JSON.stringify(entries, null, 2), 'utf8');
console.log(`[partner-admin] Updated admin credentials for "${entry.slug}" in ${targetFile}`);
