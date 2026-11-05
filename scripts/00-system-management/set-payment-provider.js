#!/usr/bin/env node
// Selects the active payment provider by editing .env in place — finds and
// replaces the PAYMENT_PROVIDER=/PAYMENT_PROVIDER_NAME= lines if present,
// appends them if not, and leaves every other line (including every other
// secret in the file) untouched.
//
// The valid provider list is imported from src/services/payments/index.js
// rather than hardcoded here, so it can never list a provider that doesn't
// actually exist in the code.
//
// Usage:
//   node scripts/00-system-management/set-payment-provider.js --provider=<key> [--name=<label>] [--dry-run]
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { paymentProviders } from '../../src/services/payments/index.js';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const PAYMENTS_DIR = path.resolve(process.cwd(), 'src', 'services', 'payments');

const KNOWN_PROVIDERS = Object.keys(paymentProviders);

const argv = yargs(hideBin(process.argv))
  .option('provider', { type: 'string', demandOption: true, desc: `Un de: ${KNOWN_PROVIDERS.join(', ')}` })
  .option('name', { type: 'string', desc: 'Libellé affiché (PAYMENT_PROVIDER_NAME) — vide pour effacer un libellé existant' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Aperçu sans écriture' })
  .help()
  .argv;

const provider = String(argv.provider).trim().toLowerCase();
if (!KNOWN_PROVIDERS.includes(provider)) {
  console.error(`❌ Provider inconnu "${provider}". Disponibles: ${KNOWN_PROVIDERS.join(', ')}`);
  process.exit(1);
}

if (!fs.existsSync(ENV_PATH)) {
  console.error('❌ .env introuvable à la racine du projet.');
  process.exit(1);
}

const raw = fs.readFileSync(ENV_PATH, 'utf8');
const hadTrailingNewline = raw.endsWith('\n');
const lines = raw.split('\n');

// Splits "value # trailing comment" so a replace can preserve the comment —
// this .env already documents valid choices this way (e.g.
// "PAYMENT_PROVIDER=mollie # helloasso | sumup | mollie"), and a naive
// whole-line replace would silently delete that documentation.
function splitInlineComment(rest) {
  const idx = rest.indexOf(' #');
  return idx === -1 ? { value: rest.trim(), comment: '' } : { value: rest.slice(0, idx).trim(), comment: rest.slice(idx) };
}

function upsertLine(lines, key, value) {
  // value === undefined -> leave untouched; value === null -> remove the line if present
  if (value === undefined) return { lines, change: null };
  const idx = lines.findIndex(l => new RegExp(`^${key}=`).test(l.trim()));
  const existing = idx !== -1 ? splitInlineComment(lines[idx].trim().slice(key.length + 1)) : null;
  const previous = existing ? existing.value : null;

  if (value === null) {
    if (idx === -1) return { lines, change: null };
    const next = lines.slice();
    next.splice(idx, 1);
    return { lines: next, change: { key, previous, next: null, removed: true } };
  }

  if (idx !== -1) {
    if (previous === value) return { lines, change: { key, previous, next: value, unchanged: true } };
    const next = lines.slice();
    next[idx] = `${key}=${value}${existing.comment}`;
    return { lines: next, change: { key, previous, next: value } };
  }
  // Append before trailing blank lines, if any, else at the end.
  const next = lines.slice();
  let insertAt = next.length;
  while (insertAt > 0 && next[insertAt - 1].trim() === '') insertAt--;
  next.splice(insertAt, 0, `${key}=${value}`);
  return { lines: next, change: { key, previous: null, next: value, added: true } };
}

let working = lines;
const changes = [];

const r1 = upsertLine(working, 'PAYMENT_PROVIDER', provider);
working = r1.lines;
if (r1.change) changes.push(r1.change);

if (argv.name !== undefined) {
  const nameValue = argv.name === '' ? null : argv.name;
  const r2 = upsertLine(working, 'PAYMENT_PROVIDER_NAME', nameValue);
  working = r2.lines;
  if (r2.change) changes.push(r2.change);
}

console.log(`→ Provider ciblé: ${provider}`);
if (!changes.length) {
  console.log('  (aucun changement — déjà configuré ainsi)');
} else {
  for (const c of changes) {
    if (c.unchanged) console.log(`  = ${c.key} déjà "${c.next}"`);
    else if (c.removed) console.log(`  - ${c.key} supprimé (était "${c.previous}")`);
    else if (c.added) console.log(`  + ${c.key}=${c.next} (nouvelle ligne)`);
    else console.log(`  ~ ${c.key}: "${c.previous}" → "${c.next}"`);
  }
}

const providerEnvFile = path.resolve(process.cwd(), `.env.${provider}`);
if (!fs.existsSync(providerEnvFile)) {
  console.log(`\n⚠ .env.${provider} introuvable — les identifiants spécifiques à ce provider n'y sont pas encore renseignés.`);
  const providerSrc = path.join(PAYMENTS_DIR, `${provider}.js`);
  try {
    const src = fs.readFileSync(providerSrc, 'utf8');
    const vars = [...new Set([...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(m => m[1]))].sort();
    if (vars.length) console.log(`  Variables référencées par ${provider}.js: ${vars.join(', ')}`);
  } catch { /* best effort */ }
} else {
  console.log(`\nℹ .env.${provider} existe déjà — vérifiez que ses valeurs sont à jour.`);
}

if (argv['dry-run']) {
  console.log('\n🧪 Dry-run — rien n\'est écrit.');
  process.exit(0);
}

if (!changes.length || changes.every(c => c.unchanged)) {
  console.log('\n✅ Rien à écrire.');
  process.exit(0);
}

const output = working.join('\n');
fs.writeFileSync(ENV_PATH, hadTrailingNewline && !output.endsWith('\n') ? output + '\n' : output);
console.log(`\n✅ .env mis à jour.`);
console.log('ℹ PAYMENT_PROVIDER est mis en cache au démarrage — redémarrez le serveur:');
console.log('    node scripts/00-system-management/pm2-control.js --name=bts --action=restart');
