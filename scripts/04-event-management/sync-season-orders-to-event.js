#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';

import { connectMongo, logDryRun } from '../_utils.js';
import { syncSeasonOrdersToEvent } from '../../src/services/event-season-sync.js';

dotenv.config();

const argv = yargs(hideBin(process.argv))
  .option('event', {
    type: 'string',
    demandOption: true,
    desc: 'Slug ou ObjectId de l\'évènement'
  })
  .option('commit', {
    type: 'boolean',
    default: false,
    desc: 'Applique les modifications (sinon dry-run)'
  })
  .help()
  .alias('h', 'help')
  .argv;

const eventArg = String(argv.event || '').trim();
if (!eventArg) {
  console.error('❌ Paramètre --event requis');
  process.exit(1);
}

const isObjectId = /^[0-9a-fA-F]{24}$/.test(eventArg);

(async () => {
  await connectMongo();
  logDryRun(argv.commit);

  const stats = await syncSeasonOrdersToEvent({
    eventId: isObjectId ? eventArg : null,
    eventSlug: isObjectId ? null : eventArg,
    dryRun: !argv.commit,
    logger: console
  });

  console.log('✅ Synchronisation terminée:', stats);
  process.exit(0);
})().catch((err) => {
  console.error('❌ Synchronisation impossible:', err.message || err);
  process.exit(1);
});
