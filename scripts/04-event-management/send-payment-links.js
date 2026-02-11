#!/usr/bin/env node
/**
 * Create checkout intents and send payment links for unpaid event orders.
 *
 * Usage:
 *   node scripts/04-event-management/send-payment-links.js \
 *     --event=<slug|ObjectId> [--order=<id[,id2]>] [--status=pending,tobepaid] [--limit=200] [--commit] [--mail=false]
 *
 * Notes:
 *   - Dry-run by default; use --commit to call the payment provider and send emails.
 *   - --status supports:
 *       pending,tobepaid   (default)
 *       nonpaid            (all statuses that are not paid/refunded)
 *       all
 *       comma list         (example: pending,failed,canceled)
 *   - Use --order to target specific order IDs.
 */

import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { connectMongo } from '../_utils.js';
import { Event } from '../../src/models/Event.js';
import { Order } from '../../src/models/Order.js';
import {
  currentPaymentProviderId,
  currentPaymentProviderLabel
} from '../../src/services/payments/index.js';
import { isPaidLike } from '../../src/services/order-finalization.js';
import {
  createPaymentLinkForOrder,
  sendPaymentLinkEmail
} from '../../src/services/payment-links.js';

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
    default: 'pending,tobepaid',
    desc: 'pending,tobepaid | nonpaid | all | comma-list'
  })
  .option('limit', {
    type: 'number',
    default: 200,
    desc: 'Maximum number of orders to process (ignored when --order is set)'
  })
  .option('mail', {
    type: 'boolean',
    default: true,
    desc: 'Send payment-link email (disable with --mail=false)'
  })
  .option('commit', {
    type: 'boolean',
    default: false,
    desc: 'Actually create checkout intents and send emails'
  })
  .help()
  .argv;

const EVENT_KEY = String(argv.event || '').trim();
const COMMIT = argv.commit === true;
const DRY_RUN = !COMMIT;
const SEND_EMAIL = argv.mail !== false;
const STATUS_FILTER = String(argv.status || 'pending,tobepaid').trim().toLowerCase() || 'pending,tobepaid';
const LIMIT = Math.max(1, Number(argv.limit || 200));
const PROVIDER_ID = currentPaymentProviderId();
const PROVIDER_LABEL = currentPaymentProviderLabel();
const SOURCE = 'script:send-payment-links';

function collectOrderIds() {
  const ids = new Set();
  const rawFlags = Array.isArray(argv.order) ? argv.order : [];
  for (const raw of rawFlags) {
    if (!raw) continue;
    String(raw)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .forEach((v) => ids.add(v));
  }
  return Array.from(ids);
}

function formatEventRef(ev) {
  if (!ev) return '';
  return `${ev.slug || ev._id} (${ev._id})`;
}

function fmtEuro(cents) {
  return (Number(cents || 0) / 100).toLocaleString('fr-FR', {
    style: 'currency',
    currency: 'EUR'
  });
}

function statusAccepted(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'canceled' || s === 'refunded') return false;
  if (STATUS_FILTER === 'all') return true;
  if (STATUS_FILTER === 'nonpaid') {
    return !isPaidLike(s);
  }
  const set = new Set(
    STATUS_FILTER.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
  );
  if (!set.size) return s === 'pending' || s === 'tobepaid';
  return set.has(s);
}

function orderMatchesEvent(order, event) {
  const evId = String(event._id);
  const evSlug = String(event.slug || '');
  const topEventId = order?.eventId ? String(order.eventId) : '';
  const orderEventId = order?.meta?.eventId ? String(order.meta.eventId) : '';
  const orderEventSlug = order?.meta?.eventSlug ? String(order.meta.eventSlug) : '';
  if (topEventId && topEventId === evId) return true;
  if (orderEventId && orderEventId === evId) return true;
  if (!orderEventId && orderEventSlug && orderEventSlug === evSlug) return true;
  return false;
}

async function resolveEvent() {
  const key = EVENT_KEY;
  if (!key) return null;

  if (mongoose.isValidObjectId(key)) {
    const byId = await Event.findById(key).lean();
    if (byId) return byId;
  }
  const bySlug = await Event.findOne({ slug: key }).lean();
  if (bySlug) return bySlug;
  return null;
}

async function loadOrderByRef(rawId) {
  if (!rawId) return null;
  const id = String(rawId).trim();
  if (!id) return null;
  if (mongoose.isValidObjectId(id)) {
    const byId = await Order.findById(id);
    if (byId) return byId;
  }
  return Order.findOne({ 'paymentProviderMeta.legacyOrderId': id });
}

async function loadCandidates(event, explicitOrderIds) {
  if (explicitOrderIds.length) {
    const dedup = new Map();
    const missingRefs = [];
    for (const rawId of explicitOrderIds) {
      const order = await loadOrderByRef(rawId);
      if (!order) {
        missingRefs.push(rawId);
        continue;
      }
      dedup.set(String(order._id), order);
    }
    return { orders: Array.from(dedup.values()), missingRefs };
  }

  const orders = await Order.find({
    $or: [{ eventId: event._id }, { 'meta.eventId': String(event._id) }]
  })
    .sort({ createdAt: -1 })
    .limit(LIMIT);
  return { orders, missingRefs: [] };
}

async function main() {
  if (!EVENT_KEY) {
    console.error('❌ Missing --event <slug|ObjectId>');
    process.exit(1);
  }

  const explicitOrderIds = collectOrderIds();
  await connectMongo();

  const event = await resolveEvent();
  if (!event) {
    console.error(`❌ Event not found for key "${EVENT_KEY}"`);
    process.exit(1);
  }

  const { orders: candidates, missingRefs } = await loadCandidates(event, explicitOrderIds);

  console.log(DRY_RUN ? '🧪 Dry-run — aucun lien ni email ne sera envoyé.' : '⚠️  Commit activé — création des liens + envoi email.');
  console.log(`→ Event: ${formatEventRef(event)}`);
  console.log(`→ Provider: ${PROVIDER_LABEL} (${PROVIDER_ID})`);
  console.log(`→ Status filter: ${STATUS_FILTER}`);
  if (explicitOrderIds.length) {
    console.log(`→ Orders ciblés: ${explicitOrderIds.length}`);
  } else {
    console.log(`→ Limit: ${LIMIT}`);
  }
  console.log(`→ Candidates found: ${candidates.length}`);

  const stats = {
    processed: 0,
    linkCreated: 0,
    emailed: 0,
    preview: 0,
    skipped: 0,
    skippedPaid: 0,
    skippedStatus: 0,
    skippedEventMismatch: 0,
    skippedNoEmail: 0,
    skippedNoAmount: 0,
    missingOrders: 0,
    errors: 0
  };

  if (missingRefs.length) {
    stats.missingOrders += missingRefs.length;
    missingRefs.forEach((ref) => {
      console.warn(`⚠️  Order introuvable: ${ref}`);
    });
  }

  for (const order of candidates) {
    stats.processed += 1;
    const orderId = String(order._id);
    const status = String(order.status || '').toLowerCase();

    if (!orderMatchesEvent(order, event)) {
      stats.skipped += 1;
      stats.skippedEventMismatch += 1;
      console.warn(`⚠️  ${orderId} ignored (event mismatch).`);
      continue;
    }

    if (isPaidLike(status)) {
      stats.skipped += 1;
      stats.skippedPaid += 1;
      continue;
    }

    if (status === 'canceled' || status === 'refunded') {
      stats.skipped += 1;
      stats.skippedStatus += 1;
      continue;
    }

    if (!statusAccepted(status)) {
      stats.skipped += 1;
      stats.skippedStatus += 1;
      continue;
    }

    if (!order.payerEmail) {
      stats.skipped += 1;
      stats.skippedNoEmail += 1;
      console.warn(`⚠️  ${orderId} skipped (payerEmail missing).`);
      continue;
    }

    if (!Number.isFinite(Number(order.totalCents)) || Number(order.totalCents) <= 0) {
      stats.skipped += 1;
      stats.skippedNoAmount += 1;
      console.warn(`⚠️  ${orderId} skipped (totalCents invalid: ${order.totalCents}).`);
      continue;
    }

    if (DRY_RUN) {
      stats.preview += 1;
      console.log(`[dry-run] ${orderId} status=${status} email=${order.payerEmail} amount=${fmtEuro(order.totalCents)}`);
      continue;
    }

    try {
      const link = await createPaymentLinkForOrder(order, { source: SOURCE });
      stats.linkCreated += 1;

      if (SEND_EMAIL) {
        await sendPaymentLinkEmail(order, {
          redirectUrl: link.redirectUrl,
          eventName: order?.meta?.eventName || event?.name || event?.slug || '',
          providerLabel: link.providerLabel
        });
        stats.emailed += 1;
      }

      console.log(`✓ ${orderId} link created${SEND_EMAIL ? ' + email sent' : ''} -> ${order.payerEmail}`);
    } catch (err) {
      stats.errors += 1;
      console.error(`❌ ${orderId}: ${err?.message || err}`);
    }
  }

  await mongoose.disconnect();
  console.log('— Résumé —');
  console.log(JSON.stringify({ dryRun: DRY_RUN, sendEmail: SEND_EMAIL, ...stats }, null, 2));
}

main().catch(async (err) => {
  console.error('❌ ERROR:', err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
