#!/usr/bin/env node
/**
 * Resend event ticket confirmations for specific orders.
 *
 * Usage:
 *   node scripts/04-event-management/resend-event-tickets-from-orders.js \
 *     --event=<slug|ObjectId> --order=<id[,id2]> [--status=paid] [--dry-run]
 */

import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { connectMongo, loadModels } from '../_utils.js';
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
    desc: 'Order ID(s); repeat the flag or provide comma-separated values'
  })
  .option('status', {
    type: 'string',
    desc: 'Force order status before sending (e.g. paid)'
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
const STATUS_OVERRIDE = argv.status ? String(argv.status).trim().toLowerCase() : null;

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
  if (!ids.size) {
    console.error('❌ Provide at least one order via --order');
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

      let needsSave = false;
      let statusChanged = false;
      let templateAdjusted = false;
      let originAdjusted = false;

      let status = String(order.status || '').toLowerCase();
      if (STATUS_OVERRIDE) {
        const desired = STATUS_OVERRIDE;
        if (status !== desired) {
          if (DRY_RUN) {
            console.log(`[dry-run] would set status=${desired} for order ${order._id} (current=${status || 'n/a'})`);
          } else {
            order.status = desired;
            statusChanged = true;
            needsSave = true;
          }
        }
        status = desired;
      }

      if (!isPaidLike(status)) {
        console.warn(`⚠️  Order ${order._id} status=${status} (non payé), skip. Ajoutez --status=paid pour forcer.`);
        stats.statusFiltered++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`[dry-run] ${order._id} → ${order.payerEmail}`);
        stats.preview++;
        continue;
      }

      if (String(order.mailTemplateKind || '').toLowerCase() !== 'event') {
        order.mailTemplateKind = 'event';
        needsSave = true;
        templateAdjusted = true;
      }
      const originFlow = String(order.origin?.flow || '').toLowerCase();
      if (originFlow !== 'event') {
        order.origin = {
          ...(order.origin || {}),
          flow: 'event',
          uiPath: order.origin?.uiPath || '/event',
          apiPath: order.origin?.apiPath || '/admin/event/resend-ticket-by-order'
        };
        needsSave = true;
        originAdjusted = true;
      }
      if (needsSave) {
        if (originAdjusted) order.markModified('origin');
        if (templateAdjusted) order.markModified('mailTemplateKind');
        if (statusChanged) order.markModified('status');
        try {
          await order.save();
          if (statusChanged) {
            console.log(`↺ Status forcé à ${String(order.status || STATUS_OVERRIDE).toLowerCase()} pour ${order._id}`);
          }
          if (templateAdjusted || originAdjusted) {
            console.log(`↺ Normalisation des métadonnées email pour ${order._id}`);
          }
        } catch (err) {
          if (statusChanged && err?.code === 11000) {
            console.warn(`⚠️  Impossible de persister status=${STATUS_OVERRIDE} pour ${order._id} (contrainte unique). Envoi de l'email tout de même.`);
            order.status = STATUS_OVERRIDE;
          } else {
            throw err;
          }
        }
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
