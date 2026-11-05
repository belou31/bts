#!/usr/bin/env node
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
import { parseArgs, writeCustoFile } from '../lib/customization-write.js';

function usage() {
  console.error('Usage: node scripts/04-event-management/set-event-custo.js --event=<slug> --file=customization.json [--dry-run]');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const eventSlug = args.event;
if (!args.file || !eventSlug) usage();

writeCustoFile({
  sourcePath: args.file,
  targetPath: path.resolve(process.cwd(), 'data', 'customization', 'events', `${eventSlug}.json`),
  scopeLabel: 'Event',
  dryRun: Boolean(args['dry-run'])
});
