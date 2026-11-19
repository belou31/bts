#!/usr/bin/env node
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
import { parseArgs, writeCustoFile } from '../lib/customization-write.js';

function usage() {
  console.error('Usage: node scripts/05-partner-management/set-partner-custo.js --partner=<slug> --file=customization.json [--season=<code>] [--event=<slug>] [--dry-run]');
  console.error('       node scripts/05-partner-management/set-partner-custo.js --all-partners --file=customization.json [--dry-run]');
  console.error('');
  console.error('  --all-partners : habillage commun à tous les partenaires (partners/_default.json).');
  console.error('                   Le texte partenaire générique s\'écrit avec {{partnerName}}, il n\'a donc');
  console.error('                   pas à être recopié pour chacun. Un fichier de partenaire le surcharge.');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const allPartners = Boolean(args['all-partners']);
const partnerSlug = args.partner;
const seasonCode = args.season;
const eventSlug = args.event;
if (!args.file) usage();
// Exactement une cible : un fichier commun OU un partenaire nommé.
if (allPartners === Boolean(partnerSlug)) usage();
if (allPartners && (seasonCode || eventSlug)) {
  console.error('--all-partners ne se combine pas avec --season / --event : ces portées sont propres à un partenaire.');
  process.exit(1);
}

let targetDir = path.resolve(process.cwd(), 'data', 'customization', 'partners');
let targetName = allPartners ? '_default.json' : `${partnerSlug}.json`;
let scopeLabel = allPartners ? 'All partners' : 'Partner';
if (seasonCode) {
  targetDir = path.join(targetDir, partnerSlug, 'seasons');
  targetName = `${seasonCode}.json`;
  scopeLabel = 'Partner+season';
} else if (eventSlug) {
  targetDir = path.join(targetDir, partnerSlug, 'events');
  targetName = `${eventSlug}.json`;
  scopeLabel = 'Partner+event';
}

writeCustoFile({
  sourcePath: args.file,
  targetPath: path.join(targetDir, targetName),
  scopeLabel,
  dryRun: Boolean(args['dry-run'])
});
