#!/usr/bin/env node
/**
 * Export event tickets to CSV (one row per ticket with QR/scan data).
 *
 * Usage:
 *   node scripts/04-event-management/export-tickets.js --event=<slug|ObjectId> [--out=tickets.csv] [--include-history]
 *
 * When --out is omitted, the CSV is streamed to stdout.
 */

import fs from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { Event } from '../../src/models/Event.js';
import { exportEventTicketsCsv } from '../../src/services/exports.js';

const argv = yargs(hideBin(process.argv))
  .option('event', {
    type: 'string',
    demandOption: true,
    desc: 'Event slug or ObjectId'
  })
  .option('out', {
    type: 'string',
    desc: 'Write CSV to this file instead of stdout'
  })
  .option('include-history', {
    type: 'boolean',
    default: false,
    desc: 'Include scanHistory column (pipe-separated chronological log)'
  })
  .help()
  .argv;

const EVENT_KEY = String(argv.event || '').trim();

async function resolveEvent() {
  if (!EVENT_KEY) throw new Error('Missing event key');
  if (mongoose.isValidObjectId(EVENT_KEY)) {
    const byId = await Event.findById(EVENT_KEY).lean();
    if (byId) return byId;
  }
  const bySlug = await Event.findOne({ slug: EVENT_KEY }).lean();
  if (!bySlug) throw new Error(`Event not found for key: ${EVENT_KEY}`);
  return bySlug;
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGO_URI/MONGODB_URI manquant');

  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(mongoUri, connectOpts);

  try {
    const event = await resolveEvent();
    const outStream = argv.out
      ? fs.createWriteStream(path.resolve(argv.out), { encoding: 'utf8' })
      : process.stdout;

    if (outStream !== process.stdout) {
      console.log(`➡️  Writing CSV to ${path.resolve(argv.out)}`);
    }

    await exportEventTicketsCsv({
      out: outStream,
      eventId: String(event._id),
      event,
      includeHeader: true,
      includeScanHistory: Boolean(argv.includeHistory)
    });

    if (outStream !== process.stdout) {
      outStream.end();
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (err) => {
  console.error('❌ ERROR:', err?.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
