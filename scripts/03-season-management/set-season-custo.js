#!/usr/bin/env node
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
import { parseArgs, writeCustoFile } from '../lib/customization-write.js';

function usage() {
  console.error('Usage: node scripts/03-season-management/set-season-custo.js --season=<code> --file=customization.json [--dry-run]');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const seasonCode = args.season;
if (!args.file || !seasonCode) usage();

writeCustoFile({
  sourcePath: args.file,
  targetPath: path.resolve(process.cwd(), 'data', 'customization', 'seasons', `${seasonCode}.json`),
  scopeLabel: 'Season',
  dryRun: Boolean(args['dry-run'])
});
