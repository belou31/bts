#!/usr/bin/env node
/**
 * Create or update a partner: data/customization/partners/<slug>/partner.json.
 *
 * Usage:
 *   node scripts/05-partner-management/upsert-partner.js --slug=<slug> --name="<Display Name>" [--template=openid|directory|none] [options]
 *
 * Options:
 *   --template=openid|directory|none   (creation only) start from the template of
 *                                      this connection kind: a full copy, edited
 *                                      afterwards in the partner's own file.
 *   --payment-mode=psp|invoice_auto    (default: psp)
 *   --allow-public-tariffs=yes|no    (default: no)
 *   --payment-provider=<id>            (for invoice_auto mode)
 *   --pay-button="<Label>"             (invoice_auto)
 *   --success-message="<Text>"         (invoice_auto)
 *   --error-message="<Text>"           (invoice_auto)
 *   --auto-finalize=yes|no             (invoice_auto, default: yes)
 *   --send-tickets=yes|no              (invoice_auto, default: yes)
 *
 * Without --template the script is additive/idempotent: an existing partner is
 * merged with the provided options and rewritten to disk. With --template, the
 * template is copied and only the options actually given override it; a
 * partner that already exists is refused (a template is never re-applied).
 */

import process from 'process';
import { readPartnerConfig, writePartnerConfig, loadPartnerTemplate } from '../../src/config/partners.js';

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

const boolOption = (name, fallback) => {
  const raw = getOption(name);
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(raw).toLowerCase());
};

const slug = (getOption('slug') || '').toLowerCase();
const name = getOption('name');
const templateKind = (getOption('template') || '').toLowerCase();

if (!slug || !name) {
  console.error('Usage: node scripts/05-partner-management/upsert-partner.js --slug=<slug> --name="<Display Name>" [--template=openid|directory|none] [options]');
  process.exit(1);
}

let existing;
try {
  existing = readPartnerConfig(slug);
} catch (err) {
  console.error(`[partners:upsert] Unable to read the config of "${slug}": ${err.message}`);
  process.exit(1);
}

const reserveFor = (paymentMode) => (paymentMode === 'invoice_auto'
  ? {
      status: 'paid',
      paymentProvider: getOption('payment-provider', `${slug}_invoice`),
      autoFinalize: boolOption('auto-finalize', true),
      sendTickets: boolOption('send-tickets', true),
      payButtonLabel: getOption('pay-button', 'Envoyer ma demande'),
      successMessage: getOption('success-message', 'Votre demande a été enregistrée. Vous recevrez vos billets par email.'),
      errorMessage: getOption('error-message', 'Impossible d’enregistrer votre demande pour le moment.')
    }
  : null);

if (templateKind) {
  if (existing.cfg) {
    console.error(`[partners:upsert] "${slug}" already exists (${existing.legacy ? 'partners.json' : existing.file}): a template only applies at creation. Edit the partner's file, or use the Set Partner … scripts.`);
    process.exit(1);
  }
  let template;
  try {
    template = loadPartnerTemplate(templateKind);
  } catch (err) {
    console.error(`[partners:upsert] ${err.message}`);
    process.exit(1);
  }
  // Seules les options données remplacent le modèle.
  const partner = { slug, name, ...template.cfg, name };
  const paymentMode = getOption('payment-mode');
  if (paymentMode) {
    partner.paymentMode = paymentMode;
    partner.reserve = reserveFor(paymentMode);
  }
  const allowPublic = boolOption('allow-public-tariffs', undefined);
  if (allowPublic !== undefined) partner.allowPublicTariffs = allowPublic;

  const written = writePartnerConfig(slug, partner);
  console.log(`[partners:upsert] Created partner "${slug}" from template ${template.source}`);
  console.log(`[partners:upsert] Written ${written}`);
  template.notes.forEach(n => console.log(`  ℹ ${n}`));
  process.exit(0);
}

const paymentMode = getOption('payment-mode', 'psp');
const partner = {
  slug,
  name,
  paymentMode,
  allowPublicTariffs: boolOption('allow-public-tariffs', false),
  reserve: reserveFor(paymentMode)
};

const merged = existing.cfg ? { ...existing.cfg, ...partner } : partner;
const written = writePartnerConfig(slug, merged);
console.log(`[partners:upsert] ${existing.cfg ? 'Updated' : 'Added'} partner "${slug}"`);
console.log(`[partners:upsert] Written ${written}`);
if (!existing.cfg) console.log('[partners:upsert] No template given: connection "none". Use --template=openid|directory|none to start from a full model.');
