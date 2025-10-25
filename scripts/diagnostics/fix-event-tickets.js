#!/usr/bin/env node
// scripts/diagnostics/fix-event-tickets.js
import 'dotenv/config';
import process from 'node:process';
import mongoose from 'mongoose';

import { connectDB } from '../../src/loaders/mongoose.js';
import { Event } from '../../src/models/Event.js';
import { Order } from '../../src/models/Order.js';
import { Ticket } from '../../src/models/Ticket.js';
import { ensureTicketsForEventOrder } from '../../src/services/order-finalization.js';

function usage() {
  console.log('Usage: node scripts/diagnostics/fix-event-tickets.js --event=<slugOrId> [--apply]');
}

function parseArgs(argv) {
  let eventKey = '';
  let apply = false;
  for (const arg of argv) {
    if (arg === '--apply' || arg === '--yes') apply = true;
    else if (arg.startsWith('--event=')) eventKey = arg.slice('--event='.length).trim();
    else if (!arg.startsWith('--') && !eventKey) eventKey = arg.trim();
  }
  return { eventKey, apply };
}

async function loadEventByKey(key) {
  const raw = String(key || '').trim();
  if (!raw) return null;
  if (mongoose.isValidObjectId(raw)) {
    const byId = await Event.findById(new mongoose.Types.ObjectId(raw)).lean();
    if (byId) return byId;
  }
  return Event.findOne({ slug: raw }).lean();
}

async function fetchOrdersForEvent(eventDoc) {
  const eventId = String(eventDoc._id);
  const baseQuery = { status: 'paid', 'meta.eventId': eventId };
  return Order.find(baseQuery).sort({ createdAt: 1 });
}

async function cleanupOrphanTickets(eventId, apply) {
  const candidates = await Ticket.find({ eventId }).select('_id orderId');
  const garbage = [];
  for (const doc of candidates) {
    if (doc.orderId) continue;
    garbage.push(doc._id);
  }
  if (!garbage.length) return 0;
  if (!apply) {
    console.log(`Would remove ${garbage.length} ticket(s) with missing order reference.`);
    return garbage.length;
  }
  const res = await Ticket.deleteMany({ _id: { $in: garbage } });
  return res.deletedCount || 0;
}

async function reconcileOrder(order, eventId, apply) {
  const metaTickets = Array.isArray(order.meta?.tickets) ? order.meta.tickets : [];
  const lineCount = Array.isArray(order.lines) ? order.lines.length : 0;
  if (!lineCount) {
    return { created: 0, updated: 0, cleaned: 0, skipped: true };
  }
  if (!metaTickets.length) {
    return { created: 0, updated: 0, cleaned: 0, skipped: true };
  }

  let created = 0;
  let updated = 0;
  if (apply) {
    const result = await ensureTicketsForEventOrder(order);
    created = result.created;
    updated = result.updated;
  } else {
    // Dry-run: estimate missing tickets compared to meta
    const existing = await Ticket.countDocuments({ orderId: order._id, eventId });
    if (existing < metaTickets.length) {
      created = metaTickets.length - existing;
    }
  }

  // Refresh meta tickets after ensure (they may have been mutated in-place for real run).
  const currentMeta = Array.isArray(order.meta?.tickets) ? order.meta.tickets : [];
  const expectedIds = new Set(
    currentMeta
      .map((ticket) => (ticket?.ticketId ? String(ticket.ticketId) : ''))
      .filter(Boolean)
  );

  const existingDocs = await Ticket.find({ orderId: order._id, eventId }).select('_id');
  const toDelete = existingDocs
    .map((doc) => String(doc._id))
    .filter((id) => expectedIds.size && !expectedIds.has(id));

  let cleaned = 0;
  if (toDelete.length && apply) {
    const res = await Ticket.deleteMany({ _id: { $in: toDelete } });
    cleaned = res.deletedCount || 0;
  } else if (toDelete.length && !apply) {
    cleaned = toDelete.length;
  }

  return { created, updated, cleaned, skipped: false };
}

async function main() {
  const { eventKey, apply } = parseArgs(process.argv.slice(2));
  if (!eventKey) {
    usage();
    process.exit(1);
  }

  await connectDB();

  const eventDoc = await loadEventByKey(eventKey);
  if (!eventDoc) {
    console.error(`Event not found for key: ${eventKey}`);
    process.exit(1);
  }

  const eventId = String(eventDoc._id);
  console.log(`→ Reconciling tickets for event ${eventDoc.name || eventDoc.slug} (${eventId})`);
  if (!apply) {
    console.log('Dry-run mode: add --apply to persist changes.');
  }

  const orders = await fetchOrdersForEvent(eventDoc);
  console.log(`Found ${orders.length} order(s) to inspect.`);

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalCleaned = 0;
  let skipped = 0;
  let processed = 0;

  for (const order of orders) {
    const orderId = String(order._id);
    const lineCount = Array.isArray(order.lines) ? order.lines.length : 0;
    const { created, updated, cleaned, skipped: didSkip } = await reconcileOrder(order, eventId, apply);
    if (didSkip) {
      skipped++;
      continue;
    }

    totalCreated += created;
    totalUpdated += updated;
    totalCleaned += cleaned;
    processed++;

    if (created || updated || cleaned) {
      console.log(` [${orderId}] lines=${lineCount} +${created} updated=${updated} cleaned=${cleaned}`);
    }
  }

  const orphanCleaned = await cleanupOrphanTickets(eventId, apply);
  totalCleaned += orphanCleaned;

  console.log('--- Summary ---');
  console.log(`Orders processed: ${processed}`);
  console.log(`Orders skipped (no meta.tickets or lines): ${skipped}`);
  console.log(`Tickets created: ${totalCreated}`);
  console.log(`Tickets updated: ${totalUpdated}`);
  console.log(`Tickets cleaned up: ${totalCleaned}`);
  if (!apply) {
    console.log('No changes were written (dry-run). Re-run with --apply to fix the gaps.');
  }

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
