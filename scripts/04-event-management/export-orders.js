#!/usr/bin/env node
/**
 * Export event orders to CSV (one row per line item).
 *
 * Usage:
 *   node scripts/04-event-management/export-orders.js --event=<slug|ObjectId> [--status=paid] [--out=orders.csv]
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
import { Order } from '../../src/models/Order.js';

const argv = yargs(hideBin(process.argv))
  .option('event', {
    type: 'string',
    demandOption: true,
    desc: 'Event slug or ObjectId'
  })
  .option('status', {
    type: 'string',
    default: 'paid',
    desc: 'Filter orders by status (use "all" to disable)'
  })
  .option('out', {
    type: 'string',
    desc: 'Write CSV to this file instead of stdout'
  })
  .help()
  .argv;

const EVENT_KEY = String(argv.event || '').trim();
const STATUS_FILTER = String(argv.status || '').trim().toLowerCase();

const HEADER = [
  'orderId','createdAt','phase','status',
  'payerFirstName','payerLastName','payerEmail',
  'seasonCode','venueSlug','paymentSplit','totalCents',
  'providerName','haOrderId','checkoutIntentId','lastReturnCode','lastWebhookEvent','attestationSentAt',
  'lineIndex','seatId','zoneKey','tariffCode','priceCents','holderFirstName','holderLastName',
  'eventId','eventSlug','eventName','eventStartsAt'
].join(',');

const csvEscape = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

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

    const writeLine = (row) => outStream.write(row + '\n');
    writeLine(HEADER);

    const match = { 'meta.eventId': String(event._id) };
    if (STATUS_FILTER && STATUS_FILTER !== 'all') match.status = STATUS_FILTER;

    const cursor = Order.find(match).sort({ createdAt: 1 }).cursor();
    for await (const order of cursor) {
      const base = [
        order._id,
        order.createdAt?.toISOString?.() || '',
        order.phase || '',
        order.status || '',
        order.payerFirstName || '',
        order.payerLastName || '',
        order.payerEmail || '',
        order.seasonCode || '',
        order.venueSlug || '',
        order.paymentSplit ?? '',
        order.totalCents ?? 0,
        order.paymentProviderMeta?.name || order.paymentProvider || '',
        order.paymentProviderMeta?.haOrderId || '',
        order.paymentProviderMeta?.checkoutIntentId || '',
        order.paymentProviderMeta?.lastReturnCode || '',
        order.paymentProviderMeta?.lastWebhookEvent || '',
        order.paymentProviderMeta?.attestationSentAt
          ? new Date(order.paymentProviderMeta.attestationSentAt).toISOString()
          : ''
      ].map(csvEscape);

      const lines = Array.isArray(order.lines) && order.lines.length ? order.lines : [null];
      let lineIndex = 0;
      for (const line of lines) {
        const row = [
          ...base,
          csvEscape(lineIndex),
          csvEscape(line?.seatId || ''),
          csvEscape(line?.zoneKey || ''),
          csvEscape(line?.tariffCode || ''),
          csvEscape(line?.priceCents ?? 0),
          csvEscape(line?.holderFirstName || ''),
          csvEscape(line?.holderLastName || ''),
          csvEscape(String(event._id)),
          csvEscape(event.slug || ''),
          csvEscape(event.name || ''),
          event.startsAt ? csvEscape(new Date(event.startsAt).toISOString()) : ''
        ];
        writeLine(row.join(','));
        lineIndex += 1;
      }
    }

    if (outStream !== process.stdout) outStream.close();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (err) => {
  console.error('❌ ERROR:', err?.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
