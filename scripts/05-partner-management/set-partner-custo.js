#!/usr/bin/env node
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
import { parseArgs, writeCustoFile } from '../lib/customization-write.js';

function usage() {
  console.error('Usage: node scripts/05-partner-management/set-partner-custo.js --partner=<slug> --file=customization.json [--season=<code>] [--event=<slug>] [--dry-run]');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const partnerSlug = args.partner;
const seasonCode = args.season;
const eventSlug = args.event;
if (!args.file || !partnerSlug) usage();

let targetDir = path.resolve(process.cwd(), 'data', 'customization', 'partners');
let targetName = `${partnerSlug}.json`;
let scopeLabel = 'Partner';
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
