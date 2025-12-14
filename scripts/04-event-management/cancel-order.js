#!/usr/bin/env node
/**
 * Cancel an event order, release seats, and mark lines as released.
 *
 * Usage:
 *   node scripts/04-event-management/cancel-order.js --order=<orderId> [--event=<slug|ObjectId>] [--commit]
 *
 * Behaviour:
 *   - Sets order.status=canceled.
 *   - Marks each line attendance as released.
 *   - Releases seats in Seat collection for the event season/venue (status=available, clears hold/provisioned).
 *   - Dry-run by default; add --commit to persist.
 */

import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { Order } from '../../src/models/Order.js';
import { Event } from '../../src/models/Event.js';
import { Seat } from '../../src/models/Seat.js';
import { resolveLinePlacement, applyAttendancePatch } from '../../src/utils/event-attendance.js';

const argv = yargs(hideBin(process.argv))
  .option('order', { type: 'string', demandOption: true, desc: 'Order ID' })
  .option('event', { type: 'string', desc: 'Slug ou ObjectId de l’événement (validation optionnelle)' })
  .option('commit', { type: 'boolean', default: false, desc: 'Persist changes (otherwise dry-run)' })
  .help()
  .argv;

const ORDER_ID = String(argv.order || '').trim();
const EVENT_KEY = String(argv.event || '').trim();
const COMMIT = argv.commit === true;

function isObjectId(value) {
  return mongoose.isValidObjectId(String(value || ''));
}

async function loadOrder(id) {
  if (isObjectId(id)) {
    const byId = await Order.findById(id);
    if (byId) return byId;
  }
  return Order.findOne({ 'paymentProviderMeta.legacyOrderId': id });
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri) throw new Error('MONGO_URI/MONGODB_URI manquant');
  const opts = {};
  if (dbName) opts.dbName = dbName;
  await mongoose.connect(uri, opts);

  const order = await loadOrder(ORDER_ID);
  if (!order) throw new Error(`Commande introuvable: ${ORDER_ID}`);

  const evId = order.meta?.eventId || order.eventId;
  const evSlug = order.meta?.eventSlug || null;
  if (!evId && !evSlug) throw new Error('Commande sans eventId/eventSlug');

  let eventDoc = null;
  if (evId) {
    eventDoc = await Event.findById(evId).lean();
  }
  if (!eventDoc && evSlug) {
    eventDoc = await Event.findOne({ slug: evSlug }).lean();
  }
  if (!eventDoc) throw new Error('Événement lié introuvable');

  if (EVENT_KEY) {
    const matches = (isObjectId(EVENT_KEY) && String(eventDoc._id) === EVENT_KEY) || eventDoc.slug === EVENT_KEY;
    if (!matches) throw new Error(`Commande liée à ${eventDoc.slug || eventDoc._id}, différent de ${EVENT_KEY}`);
  }

  const seasonCode = eventDoc.seasonCode;
  const venueSlug = eventDoc.venueSlug;
  const lines = Array.isArray(order.lines) ? order.lines : [];

  const seatReleases = [];
  const updatedLines = lines.map((line) => {
    const placement = resolveLinePlacement(line);
    if (placement.seatId) {
      seatReleases.push({ seatId: placement.seatId, zoneKey: placement.zoneKey });
    }
    return {
      ...line.toObject?.() ?? line,
      attendance: applyAttendancePatch(line, { status: 'released', overrideZoneKey: placement.zoneKey })
    };
  });

  console.log('→ Order:', String(order._id));
  console.log('→ Event:', eventDoc.slug || eventDoc._id);
  console.log('→ Lines:', lines.length);
  console.log('→ Seats to release:', seatReleases.length);
  console.log(COMMIT ? '⚠️  Commit activé.' : '🧪 Dry-run (aucune écriture).');

  if (!COMMIT) {
    await mongoose.disconnect();
    return;
  }

  // Release seats
  for (const seat of seatReleases) {
    await Seat.updateOne(
      { seasonCode, venueSlug, seatId: seat.seatId },
      { $set: { status: 'available' }, $unset: { 'meta.hold': '', provisionedFor: '' } }
    );
  }

  // Update order
  order.status = 'canceled';
  order.lines = updatedLines;
  order.markModified('lines');
  await order.save();

  await mongoose.disconnect();
  console.log('✅ Annulation terminée.');
}

main().catch(async (err) => {
  console.error('❌', err?.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
