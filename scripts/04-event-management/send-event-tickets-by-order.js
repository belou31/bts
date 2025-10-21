#!/usr/bin/env node
/**
 * Send (or preview) event ticket confirmations for specific orders.
 *
 * Usage:
 *   node scripts/04-event-management/send-event-tickets-by-order.js \
 *     --event=<slug|ObjectId> [--order=<id[,id2]>] [--file=orders.csv] [--dry-run]
 *
 * Notes:
 *   - Requires the orders to be linked to the given event (meta.eventId / meta.eventSlug).
 *   - Accepts multiple --order flags or a comma-separated list; --file expects a CSV with an orderId column.
 *   - Dry-run prints the targets without sending e-mails.
 */

import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { connectMongo, loadModels, readCsv } from '../_utils.js';
import { sendOrderAttestationIfNeeded, isPaidLike } from '../../src/services/order-finalization.js';

const argv = yargs(hideBin(process.argv))
  .option('event', {
    type: 'string',
    demandOption: true,
    desc: 'Slug or ObjectId of the event'
  })
  .option('order', {
    type: 'string',
    array: true,
    desc: 'Order ID(s). Repeat the flag or separate values with commas.'
  })
  .option('file', {
    type: 'string',
    desc: 'CSV file containing orderId column'
  })
  .option('dry-run', {
    type: 'boolean',
    default: false,
    desc: 'Preview without sending e-mails'
  })
  .help()
  .argv;

const EVENT_KEY = String(argv.event || '').trim();
const DRY_RUN = argv['dry-run'] === true;

function collectOrderIds() {
  const ids = new Set();

  const rawFlags = Array.isArray(argv.order) ? argv.order : [];
  for (const raw of rawFlags) {
    if (!raw) continue;
    String(raw)
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
      .forEach(v => ids.add(v));
  }

  return ids;
}

async function collectFromCsv(target) {
  if (!target) return [];
  const rows = await readCsv(target);
  const keys = [];
  for (const row of rows) {
    const candidate = row.orderId ?? row.order_id ?? row.id ?? '';
    const trimmed = String(candidate || '').trim();
    if (trimmed) keys.push(trimmed);
  }
  return keys;
}

function formatEventRef(ev) {
  if (!ev) return '';
  return `${ev.slug || ev._id} (${ev._id})`;
}

async function main() {
  if (!EVENT_KEY) {
    console.error('❌ Missing --event <slug|ObjectId>');
    process.exit(1);
  }

  const ids = collectOrderIds();
  if (argv.file) {
    const fromFile = await collectFromCsv(argv.file);
    fromFile.forEach(v => ids.add(v));
  }

  if (!ids.size) {
    console.error('❌ Provide at least one order via --order or --file');
    process.exit(1);
  }

  await connectMongo();
  const { Event, Order } = loadModels();

  const event = await (async () => {
    const bySlug = await Event.findOne({ slug: EVENT_KEY }).lean();
    if (bySlug) return bySlug;
    if (mongoose.isValidObjectId(EVENT_KEY)) {
      const byId = await Event.findById(EVENT_KEY).lean();
      if (byId) return byId;
    }
    return null;
  })();

  if (!event) {
    console.error(`❌ Event not found for key "${EVENT_KEY}"`);
    process.exit(1);
  }

  const evId = String(event._id);
  const evSlug = String(event.slug || '');

  console.log(DRY_RUN ? '🧪 Dry-run — aucun email ne sera envoyé.' : '⚠️  Envoi des emails activé.');
  console.log(`→ Event: ${formatEventRef(event)}`);
  console.log(`→ Orders ciblés: ${ids.size}`);

  const stats = {
    processed: 0,
    sent: 0,
    preview: 0,
    missing: 0,
    mismatched: 0,
    statusFiltered: 0,
    errors: 0
  };

  for (const rawId of ids) {
    stats.processed++;
    let order = null;
    try {
      if (mongoose.isValidObjectId(rawId)) {
        order = await Order.findById(rawId);
      }
      if (!order) {
        order = await Order.findOne({ 'paymentProviderMeta.legacyOrderId': rawId });
      }

      if (!order) {
        console.warn(`⚠️  Order introuvable: ${rawId}`);
        stats.missing++;
        continue;
      }

      const orderEventId = order.meta?.eventId ? String(order.meta.eventId) : null;
      const orderEventSlug = order.meta?.eventSlug ? String(order.meta.eventSlug) : null;

      if (orderEventId && orderEventId !== evId) {
        console.warn(`⚠️  Order ${order._id} lié à un autre événement (${orderEventId}), skip.`);
        stats.mismatched++;
        continue;
      }
      if (!orderEventId && orderEventSlug && orderEventSlug !== evSlug) {
        console.warn(`⚠️  Order ${order._id} lié à l'événement ${orderEventSlug}, skip.`);
        stats.mismatched++;
        continue;
      }
      if (!orderEventId && !orderEventSlug) {
        console.warn(`⚠️  Order ${order._id} sans meta.eventId, skip.`);
        stats.mismatched++;
        continue;
      }

      const status = String(order.status || '').toLowerCase();
      if (!isPaidLike(status)) {
        console.warn(`⚠️  Order ${order._id} status=${status} (non payé), skip.`);
        stats.statusFiltered++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`[dry-run] ${order._id} → ${order.payerEmail}`);
        stats.preview++;
        continue;
      }

      let needsSave = false;
      if (String(order.mailTemplateKind || '').toLowerCase() !== 'event') {
        order.mailTemplateKind = 'event';
        needsSave = true;
      }
      const originFlow = String(order.origin?.flow || '').toLowerCase();
      if (originFlow !== 'event') {
        order.origin = {
          ...(order.origin || {}),
          flow: 'event',
          uiPath: order.origin?.uiPath || '/event',
          apiPath: order.origin?.apiPath || '/admin/event/send-ticket-by-order'
        };
        needsSave = true;
      }
      if (needsSave) {
        order.markModified('origin');
        await order.save();
      }

      await sendOrderAttestationIfNeeded(order);
      stats.sent++;
      console.log(`✉️  Sent ${order._id} → ${order.payerEmail}`);
    } catch (err) {
      stats.errors++;
      console.error(`❌  ${rawId}: ${err?.message || err}`);
    }
  }

  await mongoose.disconnect();
  console.log('— Résumé —');
  console.log(JSON.stringify({ event: formatEventRef(event), dryRun: DRY_RUN, ...stats }, null, 2));
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ ERROR:', err?.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
