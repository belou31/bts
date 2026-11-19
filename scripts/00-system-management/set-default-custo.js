#!/usr/bin/env node
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
import { parseArgs, writeCustoFile } from '../lib/customization-write.js';

function usage() {
  console.error('Usage: node scripts/00-system-management/set-default-custo.js --file=customization.json [--dry-run]');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.file) usage();

writeCustoFile({
  sourcePath: args.file,
  targetPath: path.resolve(process.cwd(), 'data', 'customization', 'default.json'),
  scopeLabel: 'Default',
  dryRun: Boolean(args['dry-run'])
});
