#!/usr/bin/env node
/**
 * Update partner security settings (allowed origins / frame-ancestors).
 *
 * Usage:
 *   node scripts/05-partner-management/set-partner-security.js --slug=<slug> [--allowed-origins=CSV] [--frame-ancestors=CSV]
 */

import process from 'process';
import { readPartnerConfig, writePartnerConfig } from '../../src/config/partners.js';

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

let found;
try {
  found = readPartnerConfig(slug);
} catch (err) {
  console.error(`[partner-security] Unable to read the partner config: ${err.message}`);
  process.exit(1);
}
if (!found.cfg) {
  console.error(`[partner-security] Partner "${slug}" not found (${found.file}).`);
  process.exit(1);
}

const updated = { ...found.cfg };
if (allowedOriginsOpt !== undefined) {
  updated.allowedOrigins = parseList(allowedOriginsOpt);
}
if (frameAncestorsOpt !== undefined) {
  updated.frameAncestors = parseList(frameAncestorsOpt);
}

writePartnerConfig(slug, updated);
console.log(`[partner-security] Updated security for "${slug}"`);
