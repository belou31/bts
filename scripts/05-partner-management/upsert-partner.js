#!/usr/bin/env node
/**
 * Create or update a partner entry in data/customization/partners.json.
 *
 * Usage:
 *   node scripts/05-partner-management/upsert-partner.js --slug=<slug> --name="<Display Name>" [options]
 *
 * Options:
 *   --payment-mode=psp|invoice_auto    (default: psp)
 *   --allowed-origins=https://a.com,https://b.com
 *   --frame-ancestors=https://a.com,https://b.com
 *   --payment-provider=<id>            (for invoice_auto mode)
 *   --pay-button="<Label>"             (invoice_auto)
 *   --success-message="<Text>"         (invoice_auto)
 *   --error-message="<Text>"           (invoice_auto)
 *   --auto-finalize=yes|no             (invoice_auto, default: yes)
 *   --send-tickets=yes|no              (invoice_auto, default: yes)
 *   --venue-view=<slug>                (optional custom plan view)
 *   --ui-heading="<Title>"
 *   --ui-lead="<Lead text>"
 *   --ui-payment-help="<Help text>"
 *
 * The script is additive/idempotent: an existing entry with the same slug
 * will be merged with the provided options and rewritten to disk.
 */

import fs from 'fs';
import path from 'path';
import process from 'process';

const args = process.argv.slice(2);

const aTrim = v => (v == null ? v : String(v).trim());

const getOption = (name, defaultValue = undefined) => {
  const prefix = `--${name}=`;
  const direct = args.find(a => a.startsWith(prefix));
  if (direct) return aTrim(direct.slice(prefix.length));
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1]) return aTrim(args[index + 1]);
  return defaultValue;
};

const parseList = (val = '') =>
  aTrim(val)
    ?.split(/[,\s]+/)
    .map(v => v.trim())
    .filter(Boolean) || [];

const boolOption = (name, fallback) => {
  const raw = getOption(name);
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(raw).toLowerCase());
};

const slug = getOption('slug');
const name = getOption('name');

if (!slug || !name) {
  console.error('Usage: node scripts/05-partner-management/upsert-partner.js --slug=<slug> --name="<Display Name>" [options]');
  process.exit(1);
}

const paymentMode = getOption('payment-mode', 'psp');
const allowedOrigins = parseList(getOption('allowed-origins', ''));
const frameAncestors = parseList(getOption('frame-ancestors', ''));
const venueView = getOption('venue-view');

const reserve =
  paymentMode === 'invoice_auto'
    ? {
        status: 'paid',
        paymentProvider: getOption('payment-provider', `${slug}_invoice`),
        autoFinalize: boolOption('auto-finalize', true),
        sendTickets: boolOption('send-tickets', true),
        payButtonLabel: getOption('pay-button', 'Envoyer ma demande'),
        successMessage: getOption('success-message', 'Votre demande a été enregistrée. Vous recevrez vos billets par email.'),
        errorMessage: getOption('error-message', 'Impossible d’enregistrer votre demande pour le moment.')
      }
    : null;

const partner = {
  slug: slug.toLowerCase(),
  name,
  paymentMode,
  allowedOrigins,
  frameAncestors,
  venueView,
  reserve,
  ui: {
    heading: getOption('ui-heading', name),
    lead: getOption('ui-lead', ''),
    paymentHelp: getOption('ui-payment-help', paymentMode === 'invoice_auto' ? 'Facturation différée via le partenaire.' : 'Paiement sécurisé via BTS.')
  }
};

const targetDir = path.resolve(process.cwd(), 'data', 'customization');
const targetFile = path.join(targetDir, 'partners.json');
fs.mkdirSync(targetDir, { recursive: true });

let entries = [];
if (fs.existsSync(targetFile)) {
  try {
    const raw = fs.readFileSync(targetFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) entries = parsed;
  } catch (err) {
    console.error(`[partners:upsert] Unable to read ${targetFile}: ${err.message}`);
    process.exit(1);
  }
}

const idx = entries.findIndex(e => (e?.slug || '').toLowerCase() === partner.slug);
if (idx >= 0) {
  entries[idx] = {
    ...entries[idx],
    ...partner,
    reserve: partner.reserve,
    slug: partner.slug
  };
  console.log(`[partners:upsert] Updated partner "${partner.slug}"`);
} else {
  entries.push(partner);
  console.log(`[partners:upsert] Added partner "${partner.slug}"`);
}

fs.writeFileSync(targetFile, JSON.stringify(entries, null, 2), 'utf8');
console.log(`[partners:upsert] Written ${entries.length} partner(s) to ${targetFile}`);
