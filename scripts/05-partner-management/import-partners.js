#!/usr/bin/env node
/**
 * Import partners from CSV into data/customization/partners.json.
 *
 * Usage:
 *   node scripts/05-partner-management/import-partners.js partners.csv [--replace]
 *
 * - Columns (header required):
 *   slug,name,paymentMode,allowedOrigins,frameAncestors,accessToken,allowPublicTariffs,venueView,paymentProvider,payButtonLabel,successMessage,errorMessage,autoFinalize,sendTickets,uiHeading,uiLead,uiPaymentHelp
 * - allowedOrigins / frameAncestors: comma or space separated list.
 * - paymentMode: psp | invoice_auto.
 * - autoFinalize / sendTickets: yes/no/true/false (invoice_auto only).
 * - When --replace is passed, the file is overwritten with the CSV content.
 *   Otherwise, entries are merged by slug with existing partners.json.
 */

import fs from 'fs';
import path from 'path';
import process from 'process';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const REPLACE = args.includes('--replace');

if (!file) {
  console.error('Usage: node scripts/05-partner-management/import-partners.js partners.csv [--replace]');
  process.exit(1);
}

const targetDir = path.resolve(process.cwd(), 'data', 'customization');
const targetFile = path.join(targetDir, 'partners.json');
fs.mkdirSync(targetDir, { recursive: true });

const parseList = (val = '') =>
  String(val || '')
    .split(/[,\s]+/)
    .map(v => v.trim())
    .filter(Boolean);

const toBool = (val, fallback = false) => {
  if (val == null || val === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(val).toLowerCase());
};

function readCsv(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const row = {};
    header.forEach((key, idx) => {
      row[key.trim()] = cols[idx] ?? '';
    });
    return row;
  });
}

function loadExisting() {
  if (!fs.existsSync(targetFile)) return [];
  try {
    const raw = fs.readFileSync(targetFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[partners:import] Unable to read existing file, ignoring: ${err.message}`);
    return [];
  }
}

const rows = readCsv(file);
if (!rows.length) {
  console.error('[partners:import] No rows found in CSV');
  process.exit(1);
}

const imported = rows
  .map(r => {
    const slug = (r.slug || '').trim().toLowerCase();
    const name = (r.name || '').trim();
    if (!slug || !name) return null;
    const paymentMode = (r.paymentMode || 'psp').trim() || 'psp';
    const allowedOrigins = parseList(r.allowedOrigins || r.allowedOrigin);
    const frameAncestors = parseList(r.frameAncestors || r.frameAncestor);
    const allowPublicTariffs = toBool(r.allowPublicTariffs, false);
    const venueView = (r.venueView || '').trim() || undefined;
    const isInvoice = paymentMode === 'invoice_auto';
    const reserve = isInvoice
      ? {
          status: 'paid',
          paymentProvider: (r.paymentProvider || `${slug}_invoice`).trim(),
          autoFinalize: toBool(r.autoFinalize, true),
          sendTickets: toBool(r.sendTickets, true),
          payButtonLabel: (r.payButtonLabel || 'Envoyer ma demande').trim(),
          successMessage: (r.successMessage || 'Votre demande a été enregistrée. Vous recevrez vos billets par email.').trim(),
          errorMessage: (r.errorMessage || 'Impossible d’enregistrer votre demande pour le moment.').trim()
        }
      : null;

    return {
      slug,
      name,
      paymentMode,
      allowedOrigins,
      frameAncestors,
      allowPublicTariffs,
      venueView,
      reserve,
      accessToken: (r.accessToken || r.token || '').trim(),
      ui: {
        heading: (r.uiHeading || name).trim(),
        lead: (r.uiLead || '').trim(),
        paymentHelp: (r.uiPaymentHelp ||
          (isInvoice ? 'Facturation différée via le partenaire.' : 'Paiement sécurisé via BTS.')).trim()
      }
    };
  })
  .filter(Boolean);

let finalEntries = imported;
if (!REPLACE) {
  const existing = loadExisting();
  const map = new Map();
  [...existing, ...imported].forEach(p => {
    if (!p?.slug) return;
    map.set(p.slug, { ...(map.get(p.slug) || {}), ...p });
  });
  finalEntries = Array.from(map.values());
}

fs.writeFileSync(targetFile, JSON.stringify(finalEntries, null, 2), 'utf8');
console.log(`[partners:import] ${finalEntries.length} partner(s) written to ${targetFile}`);
if (!REPLACE) {
  console.log(`[partners:import] merged ${imported.length} row(s) from CSV`);
}
