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

const REAL_SEAT_RE = /^[A-Z0-9]+-[A-Z]-[0-9]{1,4}$/;

function normalizeSeat(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizeZone(value) {
  return normalizeSeat(value);
}

function placeholderSeat(zoneKey, orderId, index) {
  const zone = normalizeZone(zoneKey) || 'ZONE';
  const suffix = String(orderId).slice(-6).toUpperCase();
  const idx = String(index + 1).padStart(2, '0');
  return `${zone}-GA-${suffix}-${idx}`;
}

function generateTicketHex(orderId, index, seatId, zoneKey, tariffCode) {
  const seat = seatId ? `S:${seatId}` : `Z:${zoneKey || 'ZONE'}`;
  const tariff = tariffCode ? `T:${tariffCode}` : 'T:NORMAL';
  const payload = `E:${orderId}:${seat}:${tariff}:${index}`;
  return Buffer.from(payload, 'utf8').toString('base64').replace(/=+$/, '');
}

function buildMetaTickets(orderDoc, eventId, existingTickets) {
  const orderId = String(orderDoc._id);
  const lines = Array.isArray(orderDoc.lines) ? orderDoc.lines : [];
  const tickets = Array.isArray(existingTickets) ? existingTickets : [];

  const bySeat = new Map();
  const unused = new Set();
  for (const ticket of tickets) {
    const seat = normalizeSeat(ticket.seatId);
    if (!bySeat.has(seat)) bySeat.set(seat, []);
    bySeat.get(seat).push(ticket);
    unused.add(String(ticket._id));
  }

  const usedHex = new Set();
  for (const ticket of tickets) {
    const hex = String(ticket?.qr?.value || '').trim();
    if (hex) usedHex.add(hex);
  }

  const metaTickets = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || {};
    const seatIdRaw = normalizeSeat(line.seatId);
    const zoneKey = normalizeZone(line.zoneKey);
    const tariff = normalizeZone(line.tariffCode || 'NORMAL') || 'NORMAL';
    const holderFirstName = String(line.holderFirstName || '').trim();
    const holderLastName = String(line.holderLastName || '').trim();
    const holderEmail = String(line.holderEmail || orderDoc.payerEmail || '').trim();

    let matchedTicket = null;
    if (seatIdRaw && bySeat.has(seatIdRaw)) {
      matchedTicket = bySeat.get(seatIdRaw).shift();
    } else if (!seatIdRaw && zoneKey) {
      const zonePrefix = `${zoneKey}-GA-`;
      for (const [seatKey, list] of bySeat.entries()) {
        if (!list.length) continue;
        if (seatKey.startsWith(zonePrefix)) {
          matchedTicket = list.shift();
          break;
        }
      }
    }

    if (matchedTicket) {
      unused.delete(String(matchedTicket._id));
    }

    const seatForTicket = matchedTicket?.seatId || (seatIdRaw || placeholderSeat(zoneKey || matchedTicket?.seatId || 'ZONE', orderId, i));
    const zoneForTicket = zoneKey || normalizeZone(matchedTicket?.seatId?.split('-')?.[0] || matchedTicket?.zoneKey);
    let hex = String(matchedTicket?.qr?.value || '').trim();
    if (!hex) {
      hex = generateTicketHex(orderId, i, REAL_SEAT_RE.test(seatForTicket) ? seatForTicket : null, zoneForTicket, tariff);
      while (usedHex.has(hex)) {
        hex = generateTicketHex(orderId, i + usedHex.size + 1, REAL_SEAT_RE.test(seatForTicket) ? seatForTicket : null, zoneForTicket, tariff);
      }
    }
    usedHex.add(hex);

    metaTickets.push({
      seatId: seatForTicket,
      zoneKey: zoneForTicket,
      holderFirstName,
      holderLastName,
      holderEmail,
      tariff,
      tariffCode: tariff,
      hex,
      value: hex,
      createdAt: matchedTicket?.qr?.createdAt || new Date()
    });
  }

  return { metaTickets, leftoverTicketIds: Array.from(unused) };
}

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
  const lineCount = Array.isArray(order.lines) ? order.lines.length : 0;
  if (!lineCount) {
    return { created: 0, updated: 0, cleaned: 0, skipped: true };
  }

  const existingDocs = await Ticket.find({ orderId: order._id, eventId }).lean();
  const { metaTickets, leftoverTicketIds } = buildMetaTickets(order, eventId, existingDocs);

  let created = 0;
  let updated = 0;
  let cleaned = 0;

  if (apply) {
    order.meta = order.meta || {};
    order.meta.tickets = metaTickets;
    order.markModified('meta.tickets');
    await order.save();

    const result = await ensureTicketsForEventOrder(order);
    created += result.created;
    updated += result.updated;

    const refreshedOrder = await Order.findById(order._id).select('meta.tickets').lean();
    const expectedIds = new Set(
      (Array.isArray(refreshedOrder?.meta?.tickets) ? refreshedOrder.meta.tickets : [])
        .map((ticket) => String(ticket?.ticketId || ''))
        .filter(Boolean)
    );

    const currentTicketIds = await Ticket.find({ orderId: order._id, eventId }).select('_id').lean();
    const toDelete = currentTicketIds
      .map((doc) => String(doc._id))
      .filter((id) => expectedIds.size && !expectedIds.has(id));
    if (toDelete.length) {
      const res = await Ticket.deleteMany({ _id: { $in: toDelete } });
      cleaned += res.deletedCount || 0;
    }

    if (leftoverTicketIds.length) {
      const res = await Ticket.deleteMany({ _id: { $in: leftoverTicketIds } });
      cleaned += res.deletedCount || 0;
    }
  } else {
    const existingCount = existingDocs.length;
    if (existingCount < metaTickets.length) {
      created += metaTickets.length - existingCount;
    }
    if (existingCount > metaTickets.length) {
      cleaned += existingCount - metaTickets.length;
    }
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
