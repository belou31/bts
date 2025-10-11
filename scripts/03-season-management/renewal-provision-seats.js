#!/usr/bin/env node
/**
 * Provision renewal seats
 *
 * Marks previous-season seats as `provisioned` for each subscriber so that renewal
 * links can reserve them. Runs in dry-run mode unless --apply is provided.
 *
 * Usage:
 *   node scripts/03-season-management/renewal-provision-seats.js <seasonCode> [--venue=slug] [--verbose] [--apply]
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 *
 * Template:
 */
import mongoose from 'mongoose';

import { Season } from '../../src/models/Season.js';
import { Subscriber } from '../../src/models/Subscriber.js';
import { Seat } from '../../src/models/Seat.js';

import dotenv from 'dotenv';
dotenv.config();

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      positional.push(raw);
      continue;
    }
    const body = raw.slice(2);
    if (!body) continue;
    const eq = body.indexOf('=');
    if (eq === -1) options[body] = true;
    else options[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return { positional, options };
}

(async () => {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const seasonCode = positional[0];
  if (!seasonCode) {
    console.error('Usage: node scripts/03-season-management/renewal-provision-seats.js <seasonCode> [--venue=slug] [--verbose] [--apply]');
    process.exit(1);
  }

  const verbose = options.verbose !== undefined;
  const apply = options.apply !== undefined;
  let venueSlug = options.venue ?? null;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('Missing MONGO_URI/MONGODB_URI');
    process.exit(1);
  }
  await mongoose.connect(uri);

  if (!venueSlug) {
    const season = await Season.findOne({ code: seasonCode }, { venueSlug: 1 }).lean();
    venueSlug = season?.venueSlug || null;
  }

  const subscriberQuery = { seasonCode };
  if (venueSlug) subscriberQuery.venueSlug = venueSlug;

  let scanned = 0;
  let provisioned = 0;
  let skippedBooked = 0;
  let notFound = 0;

  const cursor = Subscriber.find(subscriberQuery, { previousSeasonSeats: 1 }).lean().cursor();
  for await (const sub of cursor) {
    const seats = Array.from(new Set((sub.previousSeasonSeats || [])
      .map(x => String(x || '').trim().toUpperCase())
      .filter(Boolean)));

    for (const seatId of seats) {
      scanned++;
      const seatFilter = { seasonCode, seatId };
      if (venueSlug) seatFilter.venueSlug = venueSlug;

      const seat = await Seat.findOne(seatFilter);
      if (!seat) {
        notFound++;
        if (verbose) console.warn(`[NF] ${seatId}`);
        continue;
      }
      if (seat.status === 'booked') {
        skippedBooked++;
        if (verbose) console.log(`[SKIP booked] ${seatId}`);
        continue;
      }

      if (apply) {
        seat.status = 'provisioned';
        seat.provisionedFor = sub._id;
        await seat.save();
      }
      provisioned++;
      if (verbose) console.log(`[PROVISION] ${seatId} for subscriber ${sub._id}`);
    }
  }

  console.log(`Done. scanned=${scanned} provisioned=${provisioned} booked_skipped=${skippedBooked} not_found=${notFound} apply=${apply}`);
  console.log(apply ? 'Changes have been written to MongoDB.' : 'Dry-run only. Rerun with --apply to persist.');

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
