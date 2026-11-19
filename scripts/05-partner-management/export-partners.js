#!/usr/bin/env node
/**
 * Export partners (data/customization/partners/<slug>/partner.json) to CSV.
 *
 * Usage:
 *   node scripts/05-partner-management/export-partners.js [--out=partners.csv]
 *
 * If --out is omitted, the CSV is printed to stdout.
 */

import fs from 'fs';
import path from 'path';
import process from 'process';
import { listPartnerConfigs } from '../../src/config/partners.js';

const args = process.argv.slice(2);
const outOpt = args.find(a => a.startsWith('--out='));
const out = outOpt ? outOpt.split('=')[1] : null;

const partners = listPartnerConfigs();
if (!partners.length) {
  console.error('[partners:export] No partner configured.');
  process.exit(1);
}

const header = [
  'slug',
  'name',
  'paymentMode',
  'allowedOrigins',
  'frameAncestors',
  'accessToken',
  'allowPublicTariffs',
  'venueView',
  'paymentProvider',
  'payButtonLabel',
  'successMessage',
  'errorMessage',
  'autoFinalize',
  'sendTickets',
  'uiHeading',
  'uiLead',
  'uiPaymentHelp'
];

const escapeCsv = (val) => {
  const s = String(val ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const rows = partners.map(p => {
  const reserve = p?.reserve || null;
  return [
    p.slug || '',
    p.name || '',
    p.paymentMode || 'psp',
    (p.allowedOrigins || []).join(' '),
    (p.frameAncestors || []).join(' '),
    p.accessToken || '',
    p.allowPublicTariffs === true ? 'true' : '',
    p.venueView || '',
    reserve?.paymentProvider || '',
    reserve?.payButtonLabel || '',
    reserve?.successMessage || '',
    reserve?.errorMessage || '',
    reserve?.autoFinalize ?? '',
    reserve?.sendTickets ?? '',
    p.ui?.heading || '',
    p.ui?.lead || '',
    p.ui?.paymentHelp || ''
  ].map(escapeCsv).join(',');
});

const output = [header.join(','), ...rows].join('\n');

if (out) {
  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, output, 'utf8');
  console.log(`[partners:export] Written ${partners.length} partner(s) to ${outPath}`);
} else {
  console.log(output);
}
