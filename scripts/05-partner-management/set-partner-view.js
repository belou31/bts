#!/usr/bin/env node
/**
 * Update partner UI/view settings (venue view and copy).
 *
 * Usage:
 *   node scripts/05-partner-management/set-partner-view.js --slug=<slug> [--venue-view=<slug>] [--ui-heading="..."] [--ui-lead="..."] [--ui-payment-help="..."]
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
  console.error('Usage: node scripts/05-partner-management/set-partner-view.js --slug=<slug> [--venue-view=<slug>] [--ui-heading="..."] [--ui-lead="..."] [--ui-payment-help="..."]');
  process.exit(1);
}

const venueViewOpt = getOption('venue-view');
const uiHeadingOpt = getOption('ui-heading');
const uiLeadOpt = getOption('ui-lead');
const uiPaymentHelpOpt = getOption('ui-payment-help');

if (venueViewOpt === undefined && uiHeadingOpt === undefined && uiLeadOpt === undefined && uiPaymentHelpOpt === undefined) {
  console.error('Provide at least one option to update (venue-view, ui-heading, ui-lead, ui-payment-help).');
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
if (venueViewOpt !== undefined) {
  updated.venueView = venueViewOpt ? String(venueViewOpt) : null;
}
const ui = { ...(updated.ui || {}) };
if (uiHeadingOpt !== undefined) ui.heading = uiHeadingOpt;
if (uiLeadOpt !== undefined) ui.lead = uiLeadOpt;
if (uiPaymentHelpOpt !== undefined) ui.paymentHelp = uiPaymentHelpOpt;
updated.ui = ui;

entries[idx] = updated;
fs.writeFileSync(targetFile, JSON.stringify(entries, null, 2), 'utf8');
console.log(`[partner-view] Updated view/UI for "${slug}"`);
