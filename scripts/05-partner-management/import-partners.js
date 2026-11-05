#!/usr/bin/env node
/**
 * Import partners from CSV, one file per partner: data/customization/partners/<slug>/partner.json.
 *
 * Usage:
 *   node scripts/05-partner-management/import-partners.js partners.csv [--replace]
 *
 * - Columns (header required):
 *   slug,name,paymentMode,allowedOrigins,frameAncestors,accessToken,allowPublicTariffs,venueView,paymentProvider,payButtonLabel,successMessage,errorMessage,autoFinalize,sendTickets,uiHeading,uiLead,uiPaymentHelp
 * - allowedOrigins / frameAncestors: comma or space separated list.
 * - paymentMode: psp | invoice_auto.
 * - autoFinalize / sendTickets: yes/no/true/false (invoice_auto only).
 * - Default: each CSV row is merged into the partner's existing config (fields
 *   not in the CSV — oidc, entitlements, admin… — are kept).
 * - --replace: each CSV row replaces its partner's config entirely. Partners
 *   absent from the CSV are left untouched (never deleted).
 */

import fs from 'fs';
import process from 'process';
import { readPartnerConfig, writePartnerConfig } from '../../src/config/partners.js';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const REPLACE = args.includes('--replace');

if (!file) {
  console.error('Usage: node scripts/05-partner-management/import-partners.js partners.csv [--replace]');
  process.exit(1);
}


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

for (const p of imported) {
  let existing = null;
  if (!REPLACE) {
    try {
      existing = readPartnerConfig(p.slug).cfg;
    } catch (err) {
      console.error(`[partners:import] Unable to read the config of "${p.slug}", not touched: ${err.message}`);
      process.exitCode = 1;
      continue;
    }
  }
  const written = writePartnerConfig(p.slug, existing ? { ...existing, ...p } : p);
  console.log(`[partners:import] ${existing ? 'merged' : REPLACE ? 'replaced' : 'created'} "${p.slug}" → ${written}`);
}
console.log(`[partners:import] ${imported.length} row(s) from CSV`);
