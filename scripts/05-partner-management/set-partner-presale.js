#!/usr/bin/env node
/**
 * Set a partner pre-sale quota, on one event or on one season.
 *
 * Un quota ouvre au partenaire une fenêtre d'anticipation : il vend avant
 * l'ouverture publique, dans cette limite. Ce que compte le quota diffère
 * selon la cible, et c'est volontaire :
 *
 *   --event=<slug>    quota = nombre de PLACES sur ce match
 *   --season=<code>   quota = nombre d'ABONNEMENTS sur cette saison
 *
 * Exactement une cible à la fois : un quota "places" et un quota
 * "abonnements" ne se déduisent pas l'un de l'autre.
 *
 * Usage:
 *   node scripts/05-partner-management/set-partner-presale.js --partner=<slug> --event=<eventSlug> --quota=<number>
 *   node scripts/05-partner-management/set-partner-presale.js --partner=<slug> --season=<seasonCode> --quota=<number>
 *   node scripts/05-partner-management/set-partner-presale.js --partner=<slug> --show
 *
 * Stores the quota under data/customization/partners.json:
 * {
 *   presale: {
 *     events:  { "<eventSlug>":  { quota: <number> } },
 *     seasons: { "<seasonCode>": { quota: <number> } }
 *   }
 * }
 */

import fs from 'fs';
import path from 'path';

function parseArgv(argv) {
  const args = {};
  argv.forEach(tok => {
    const m = tok.match(/^--([^=]+)=(.*)$/);
    if (m) {
      args[m[1]] = m[2];
    }
  });
  return args;
}

const args = parseArgv(process.argv.slice(2));
const partner = (args.partner || args.slug || '').trim().toLowerCase();
const eventSlug = (args.event || '').trim();
const seasonCode = (args.season || '').trim();
const showOnly = process.argv.includes('--show');
const quota = Number(args.quota ?? args.q ?? NaN);

if (!partner) {
  console.error('Usage: --partner=<slug> (--event=<eventSlug> | --season=<seasonCode>) --quota=<number>');
  console.error('       --partner=<slug> --show');
  process.exit(1);
}
if (!showOnly) {
  if (Boolean(eventSlug) === Boolean(seasonCode)) {
    console.error('Précisez exactement une cible : --event=<eventSlug> OU --season=<seasonCode>.');
    console.error('  --event  : quota en PLACES sur un match');
    console.error('  --season : quota en ABONNEMENTS sur une saison');
    process.exit(1);
  }
  if (!Number.isFinite(quota) || quota < 0) {
    console.error('--quota=<number> requis (0 pour retirer la prévente).');
    process.exit(1);
  }
}

const file = path.resolve(process.cwd(), 'data', 'customization', 'partners.json');
if (!fs.existsSync(file)) {
  console.error('partners.json not found at', file);
  process.exit(1);
}

const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(parsed)) {
  console.error('partners.json must contain an array.');
  process.exit(1);
}

const idx = parsed.findIndex(p => (p?.slug || '').toLowerCase() === partner);
if (idx === -1) {
  console.error(`Partner "${partner}" not found in partners.json`);
  process.exit(1);
}

const cfg = parsed[idx];
cfg.presale = cfg.presale || {};

function describe() {
  const evs = Object.entries(cfg.presale?.events || {});
  const seasons = Object.entries(cfg.presale?.seasons || {});
  console.log(`Partenaire ${partner} — préventes :`);
  if (!evs.length && !seasons.length) console.log('  (aucune)');
  evs.forEach(([k, v]) => console.log(`  événement ${k} : ${Number(v?.quota || 0)} place(s)`));
  seasons.forEach(([k, v]) => console.log(`  saison    ${k} : ${Number(v?.quota || 0)} abonnement(s)`));
}

if (showOnly) {
  describe();
  process.exit(0);
}

const bucket = eventSlug ? 'events' : 'seasons';
const key = eventSlug || seasonCode;
const unit = eventSlug ? 'place(s)' : 'abonnement(s)';
cfg.presale[bucket] = cfg.presale[bucket] || {};

if (quota === 0) {
  // Retirer la prévente plutôt que laisser un quota 0, que le code lit comme
  // « pas de prévente » : autant que le fichier dise la même chose.
  delete cfg.presale[bucket][key];
} else {
  cfg.presale[bucket][key] = { quota };
}

parsed[idx] = cfg;
fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
console.log(quota === 0
  ? `✅ Prévente retirée : partenaire=${partner} ${bucket === 'events' ? 'événement' : 'saison'}=${key}`
  : `✅ Quota de prévente : partenaire=${partner} ${bucket === 'events' ? 'événement' : 'saison'}=${key} → ${quota} ${unit}`);
describe();
