#!/usr/bin/env node
/**
 * Generate/update a partner access token (global or per event/season) and print the URL.
 *
 * Usage:
 *   node scripts/05-partner-management/generate-partner-token.js --partner=<slug> [--event=<eventSlug> | --season=<seasonCode> | --default] [--force]
 *
 * Defaults to --default when no target is provided.
 * The token is stored in data/customization/partners.json under:
 *   - accessToken (default)
 *   - tokens.events[eventSlug]
 *   - tokens.seasons[seasonCode]
 * If a token already exists and --force is not provided, the existing token is reused.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import process from 'process';

const args = process.argv.slice(2);
const getOpt = (name) => {
  const prefix = `--${name}=`;
  const match = args.find(a => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
};

const partnerSlug = getOpt('partner') || getOpt('slug');
const eventSlug = getOpt('event');
const seasonCode = getOpt('season');
const isDefault = args.includes('--default') || (!eventSlug && !seasonCode);
const FORCE = args.includes('--force');

if (!partnerSlug) {
  console.error('Usage: node scripts/05-partner-management/generate-partner-token.js --partner=<slug> [--event=<eventSlug> | --season=<seasonCode> | --default] [--force]');
  process.exit(1);
}

const targetDir = path.resolve(process.cwd(), 'data', 'customization');
const targetFile = path.join(targetDir, 'partners.json');

if (!fs.existsSync(targetFile)) {
  console.error(`[partners:token] ${targetFile} not found. Initialize with init-partners or upsert first.`);
  process.exit(1);
}

const raw = fs.readFileSync(targetFile, 'utf8');
const partners = JSON.parse(raw);
if (!Array.isArray(partners)) {
  console.error('[partners:token] partners.json is not an array');
  process.exit(1);
}

const idx = partners.findIndex(p => (p?.slug || '').toLowerCase() === partnerSlug.toLowerCase());
if (idx === -1) {
  console.error(`[partners:token] partner "${partnerSlug}" not found in ${targetFile}`);
  process.exit(1);
}

const entry = partners[idx] || {};
entry.tokens = entry.tokens || { events: {}, seasons: {} };

let targetLabel = 'default';
let token = null;
if (isDefault) {
  token = entry.accessToken && !FORCE ? entry.accessToken : crypto.randomBytes(24).toString('base64url');
  entry.accessToken = token;
  targetLabel = 'default';
} else if (eventSlug) {
  const existing = entry.tokens.events?.[eventSlug];
  token = existing && !FORCE ? existing : crypto.randomBytes(24).toString('base64url');
  entry.tokens.events = entry.tokens.events || {};
  entry.tokens.events[eventSlug] = token;
  targetLabel = `event:${eventSlug}`;
} else if (seasonCode) {
  const existing = entry.tokens.seasons?.[seasonCode];
  token = existing && !FORCE ? existing : crypto.randomBytes(24).toString('base64url');
  entry.tokens.seasons = entry.tokens.seasons || {};
  entry.tokens.seasons[seasonCode] = token;
  targetLabel = `season:${seasonCode}`;
}

partners[idx] = entry;
fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(targetFile, JSON.stringify(partners, null, 2), 'utf8');

console.log(`[partners:token] ${FORCE ? 'Generated' : 'Using'} ${targetLabel} token for "${entry.slug}"`);
console.log(`[partners:token] Token: ${token}`);

const baseUrl = process.env.APP_URL || 'http://127.0.0.1:8080';
if (eventSlug) {
  const url = new URL(`/partner/${entry.slug}/event/${eventSlug}`, baseUrl);
  url.searchParams.set('token', token);
  console.log(`[partners:token] URL: ${url.toString()}`);
} else {
  console.log('[partners:token] Share the token as query param ?token=<value> on the partner URLs.');
}
