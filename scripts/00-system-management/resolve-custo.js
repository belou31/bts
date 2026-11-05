#!/usr/bin/env node
// Prints the fully-merged customization result for a given season/event/partner
// context, showing which file each key's winning value came from. Use this
// instead of tracing default.json/seasons/events/partners files by hand.
import dotenv from 'dotenv';
dotenv.config();
import { parseArgs } from '../lib/customization-write.js';
import { classifyKey } from '../lib/customization-schema.js';
import { loadCustomizationDebug } from '../../src/services/customization.js';

function usage() {
  console.error(`Usage: node scripts/00-system-management/resolve-custo.js [--season=<code>] [--event=<slug>] [--partner=<slug>] [--locale=fr|en|all]

Prints the merged customization result for the given context: which layer
files were consulted, which one won each key, and the resolved fr/en text.`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) usage();

const seasonCode = args.season || '';
const eventSlug = args.event || '';
const partnerSlug = args.partner || '';
const localeArg = args.locale || 'all';
if (!['fr', 'en', 'all'].includes(localeArg)) usage();

const { layers, merged, provenance, byLocale } = loadCustomizationDebug({ seasonCode, eventSlug, partnerSlug });

console.log('Layers consulted (later = narrower = wins on conflict):');
for (const layer of layers) {
  const mark = layer.exists ? '✓' : '·';
  const note = layer.exists ? '' : '  (not found — skipped)';
  console.log(`  ${mark} ${layer.label.padEnd(32)} ${layer.path}${note}`);
}

const keys = Object.keys(merged).sort();
console.log(`\n${keys.length} key(s) resolved:\n`);
for (const key of keys) {
  const status = classifyKey(key);
  const flag = status === 'unknown' ? '  ⚠ unrecognized key (typo?)' : status === 'unused' ? '  ℹ known key, not read by any route today' : '';
  console.log(`${key}  [from: ${provenance[key]}]${flag}`);
  if (localeArg === 'all') {
    console.log(`    fr: ${JSON.stringify(byLocale.fr[key])}`);
    console.log(`    en: ${JSON.stringify(byLocale.en[key])}`);
  } else {
    console.log(`    ${localeArg}: ${JSON.stringify(byLocale[localeArg][key])}`);
  }
}

const unknown = keys.filter(k => classifyKey(k) === 'unknown');
if (unknown.length) {
  console.log(`\n⚠ ${unknown.length} unrecognized key(s) — likely typo(s):`);
  unknown.forEach(k => console.log(`  - ${k}  (from ${provenance[k]})`));
}
