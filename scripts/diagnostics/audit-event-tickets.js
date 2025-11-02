#!/usr/bin/env node
// scripts/diagnostics/audit-event-tickets.js
import 'dotenv/config';
import process from 'node:process';
import mongoose from 'mongoose';

import { connectDB } from '../../src/loaders/mongoose.js';
import { Event } from '../../src/models/Event.js';
import { Order } from '../../src/models/Order.js';
import { Ticket } from '../../src/models/Ticket.js';

function usage() {
  console.log('Usage: node scripts/diagnostics/audit-event-tickets.js --event=<event-slug-or-id>');
}

function parseArgs(argv) {
  let eventKey = '';
  for (const arg of argv) {
    if (arg.startsWith('--event=')) {
      eventKey = arg.slice('--event='.length).trim();
    } else if (!arg.startsWith('--') && !eventKey) {
      eventKey = arg.trim();
    }
  }
  return { eventKey };
}

async function loadEvent(eventKey) {
  const key = String(eventKey || '').trim();
  if (!key) return null;

  if (mongoose.isValidObjectId(key)) {
    const byId = await Event.findById(new mongoose.Types.ObjectId(key)).lean();
    if (byId) return byId;
  }
  return Event.findOne({ slug: key }).lean();
}

function normalizeSeat(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function normalizeZone(zoneRaw) {
  const zone = normalizeSeat(zoneRaw);
  if (zone.startsWith('ZONE ')) return zone.slice(5);
  return zone;
}

function contactFromOrder(orderDoc) {
  return {
    firstName: String(orderDoc?.payerFirstName || '').trim(),
    lastName: String(orderDoc?.payerLastName || '').trim(),
    email: String(orderDoc?.payerEmail || '').trim().toLowerCase()
  };
}

function buildOrderLineKey(line, contact) {
  const seatId = normalizeSeat(line.seatId);
  if (seatId) {
    return `seat:${seatId}`;
  }
  const zone = normalizeZone(line.zoneKey);
  const holderFirst = normalizeSeat(line.holderFirstName);
  const holderLast = normalizeSeat(line.holderLastName);
  const contactEmail = contact.email;
  return `zone:${zone}|holder:${holderFirst}-${holderLast}|contact:${contactEmail}`;
}

const REAL_SEAT_RE = /^([A-Z0-9]+)-([A-Z])-([0-9]{1,4})$/;

function buildTicketKey(ticket, orderDoc) {
  const seatId = normalizeSeat(ticket.seatId);
  if (seatId && REAL_SEAT_RE.test(seatId)) {
    return `seat:${seatId}`;
  }

  const contact = contactFromOrder(orderDoc);
  const holderFirst = normalizeSeat(ticket?.holder?.firstName);
  const holderLast = normalizeSeat(ticket?.holder?.lastName);
  const zoneFromSeat = seatId.replace(/^ZONE\s+/, '');
  const zone = zoneFromSeat || normalizeZone(ticket?.tariffCode);
  return `zone:${zone}|holder:${holderFirst}-${holderLast}|contact:${contact.email}`;
}

function pushMapEntry(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function summarizeMap(map) {
  let total = 0;
  for (const arr of map.values()) total += arr.length;
  return total;
}

async function main() {
  const { eventKey } = parseArgs(process.argv.slice(2));
  if (!eventKey) {
    usage();
    process.exit(1);
  }

  await connectDB();

  const eventDoc = await loadEvent(eventKey);
  if (!eventDoc) {
    console.error(`Event not found for key: ${eventKey}`);
    process.exit(1);
  }

  const eventId = String(eventDoc._id);
  console.log(`→ Auditing event ${eventDoc.name || eventDoc.slug} (${eventId})`);

  const [tickets, eventOrders, seasonOrders] = await Promise.all([
    Ticket.find({ eventId }).lean(),
    Order.find(
      { status: 'paid', 'meta.eventId': eventId },
      { lines: 1, payerFirstName: 1, payerLastName: 1, payerEmail: 1, meta: 1 }
    ).lean(),
    Order.find(
      {
        status: 'paid',
        phase: 'subscription',
        seasonCode: eventDoc.seasonCode,
        venueSlug: eventDoc.venueSlug
      },
      { lines: 1, payerFirstName: 1, payerLastName: 1, payerEmail: 1 }
    ).lean()
  ]);

  const ticketByKey = new Map();
  const orderLineByKey = new Map();

  const orderMap = new Map();
  for (const order of [...eventOrders, ...seasonOrders]) {
    orderMap.set(String(order._id), order);
  }

  for (const order of [...eventOrders, ...seasonOrders]) {
    const contact = contactFromOrder(order);
    for (const line of order.lines || []) {
      const key = buildOrderLineKey(line, contact);
      pushMapEntry(orderLineByKey, key, {
        orderId: String(order._id),
        seatId: normalizeSeat(line.seatId),
        zone: normalizeZone(line.zoneKey),
        holderFirstName: line.holderFirstName || '',
        holderLastName: line.holderLastName || ''
      });
    }
  }

  for (const ticket of tickets) {
    const order = ticket.orderId ? orderMap.get(String(ticket.orderId)) : null;
    const key = buildTicketKey(ticket, order);
    pushMapEntry(ticketByKey, key, {
      ticketId: String(ticket._id),
      seatId: normalizeSeat(ticket.seatId),
      orderId: ticket.orderId ? String(ticket.orderId) : null
    });
  }

  const totalOrderLines = summarizeMap(orderLineByKey);
  const totalTickets = summarizeMap(ticketByKey);

  const missing = [];
  const shortages = [];
  for (const [key, entries] of orderLineByKey.entries()) {
    const produced = ticketByKey.get(key) || [];
    if (!produced.length) {
      missing.push({ key, expected: entries.length, found: 0, samples: entries.slice(0, 3) });
    } else if (produced.length < entries.length) {
      shortages.push({ key, expected: entries.length, found: produced.length, samples: entries.slice(0, 3) });
    }
  }

  const orphanTickets = [];
  for (const [key, items] of ticketByKey.entries()) {
    if (!orderLineByKey.has(key)) {
      orphanTickets.push({ key, count: items.length, samples: items.slice(0, 3) });
    }
  }

  console.log('--- Summary ---');
  console.log(`Order lines (paid): ${totalOrderLines}`);
  console.log(`Tickets stored:     ${totalTickets}`);
  console.log(`Missing keys:       ${missing.length}`);
  console.log(`Shortages:          ${shortages.length}`);
  console.log(`Orphan ticket keys: ${orphanTickets.length}`);

  const limit = 10;
  if (missing.length) {
    console.log('\nMissing entries (first %d):', Math.min(limit, missing.length));
    for (const item of missing.slice(0, limit)) {
      console.log(`- ${item.key} · expected ${item.expected} ticket(s)`);
      item.samples.forEach((sample) => {
        console.log(`    order=${sample.orderId || 'n/a'} seat=${sample.seatId || '-'} zone=${sample.zone || '-'}`);
      });
    }
  }

  if (shortages.length) {
    console.log('\nPartial shortages (first %d):', Math.min(limit, shortages.length));
    for (const item of shortages.slice(0, limit)) {
      console.log(`- ${item.key} · tickets ${item.found}/${item.expected}`);
    }
  }

  if (orphanTickets.length) {
    console.log('\nOrphan tickets (first %d):', Math.min(limit, orphanTickets.length));
    for (const item of orphanTickets.slice(0, limit)) {
      console.log(`- ${item.key} · ${item.count} ticket(s)`);
      item.samples.forEach((sample) => {
        console.log(`    ticket=${sample.ticketId} seat=${sample.seatId || '-'} order=${sample.orderId || 'n/a'}`);
      });
    }
  }

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
