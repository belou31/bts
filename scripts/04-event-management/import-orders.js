#!/usr/bin/env node
/**
 * Import event (match) orders from a CSV file.
 *
 * Usage:
 *   node scripts/04-event-management/import-orders.js <path/orders.csv> [--status=paid] [--commit] [--force] [--sendEmail]
 *
 * Notes:
 *   - CSV format follows the standard orders export: orderId,createdAt,status,payerFirstName,payerLastName,payerEmail,seasonCode,venueSlug,paymentSplit,totalCents,providerName,haOrderId,checkoutIntentId,lastReturnCode,lastWebhookEvent,attestationSentAt,lineIndex,seatId,zoneKey,tariffCode,priceCents,holderFirstName,holderLastName,eventId,eventSlug,eventName,eventStartsAt
 *   - Rows with the same orderId/orderRef/groupKey are grouped inside a single order.
 *   - When orderId is omitted, the script groups by orderRef/groupKey if present; otherwise each row becomes a distinct order.
 *   - Dry-run by default; pass --commit to persist. --sendEmail only works with --commit.
 *   - Use --force to bypass seat existence/conflict checks (useful for troubleshooting legacy data).
 */

import path from 'node:path';
import minimist from 'minimist';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import importEventOrders from '../../src/services/importers/eventOrdersImporter.js';

const args = minimist(process.argv.slice(2), {
  boolean: ['commit', 'force', 'sendEmail', 'sendEmails', 'dryRun'],
  string: ['status', 'event', 'eventId', 'eventSlug', 'file', 'csv'],
  alias: {
    file: ['csv'],
    sendEmail: ['send', 'mail'],
    sendEmails: ['emails']
  }
});

const csvPathArg = args.file || args.csv || args._[0] || '';
const STATUS_OVERRIDE = args.status ? String(args.status).trim().toLowerCase() : null;
const EVENT_OVERRIDE_RAW = args.event || args.eventId || args.eventSlug || '';

const COMMIT = !!args.commit;
const FORCE = !!args.force;
const WANT_EMAIL = !!args.sendEmail || !!args.sendEmails || !!args.send || !!args.mail || false;
const SEND_EMAIL = WANT_EMAIL && COMMIT;
const DRY_RUN = args.dryRun === true ? true : !COMMIT;

const ALLOWED_STATUS = new Set(['pending', 'paid', 'failed', 'canceled', 'authorized', 'processed']);

function usage() {
  console.error('Usage: node scripts/04-event-management/import-orders.js <path/orders.csv> [--status=paid] [--commit] [--force] [--sendEmail]');
  process.exit(1);
}

if (!csvPathArg) usage();

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!mongoUri) {
  console.error('❌ MONGO_URI/MONGODB_URI manquant');
  process.exit(1);
}

async function main() {
  await mongoose.connect(mongoUri, { dbName: process.env.MONGODB_DB });

  console.log(DRY_RUN ? '🧪 Dry-run — aucune écriture.' : '⚠️  Commit activé — écriture en base.');
  if (WANT_EMAIL && !COMMIT) {
    console.warn('ℹ️  --sendEmail ignoré en dry-run.');
  }

  const summary = await importEventOrders({
    csvPath: csvPathArg,
    dryRun: DRY_RUN,
    force: FORCE,
    sendEmail: SEND_EMAIL,
    statusOverride: STATUS_OVERRIDE,
    eventOverride: EVENT_OVERRIDE_RAW,
    paths: {
      rootDir: process.cwd(),
      inputsDir: path.resolve(process.cwd(), 'data/inputs')
    },
    logger: console
  });

  console.log('— Résumé —');
  console.log(
    `Orders: created=${summary.created} updated=${summary.updated} skipped=${summary.skipped}`
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌ ERROR:', err?.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
