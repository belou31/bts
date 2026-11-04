#!/usr/bin/env node
/**
 * Set or update partner admin credentials in data/customization/partners/<slug>/partner.json.
 *
 * Usage:
 *   node scripts/05-partner-management/set-partner-admin.js --partner=<slug> --user=<login> --pass=<password>
 */

import process from 'process';
import { readPartnerConfig, writePartnerConfig } from '../../src/config/partners.js';

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

let found;
try {
  found = readPartnerConfig(partnerSlug);
} catch (err) {
  console.error(`[partner-admin] Unable to read the partner config: ${err.message}`);
  process.exit(1);
}
if (!found.cfg) {
  console.error(`[partner-admin] partner "${partnerSlug}" not found (${found.file})`);
  process.exit(1);
}

const entry = found.cfg;
entry.admin = { user, pass };
const written = writePartnerConfig(entry.slug, entry);
console.log(`[partner-admin] Updated admin credentials for "${entry.slug}" in ${written}`);
