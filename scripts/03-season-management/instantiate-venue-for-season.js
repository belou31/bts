#!/usr/bin/env node
/**
 * Instantiate a venue for a season (seats + zones)
 *
 * Usage:
 *   node scripts/03-season-management/instantiate-venue-for-season.js <seasonCode> <venueSlug> [--skip-seats] [--skip-zones]
 *
 * Behaviour:
 *   - Reads seat templates from SeatCatalog and ensures Seat documents exist for the season.
 *   - Reads zone templates from ZoneCatalog and upserts Zone documents for the season.
 *   - Skips parts when --skip-seats or --skip-zones is provided.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import { Seat } from '../../src/models/Seat.js';
import { Zone } from '../../src/models/Zone.js';
import { SeatCatalog } from '../../src/models/SeatCatalog.js';
import { ZoneCatalog } from '../../src/models/ZoneCatalog.js';

dotenv.config();

function usage() {
  console.error('Usage: node scripts/03-season-management/instantiate-venue-for-season.js <seasonCode> <venueSlug> [--skip-seats] [--skip-zones]');
  process.exit(1);
}

function parseArgs(argv) {
  const options = new Set();
  const positional = [];
  argv.forEach(token => {
    if (token.startsWith('--')) options.add(token);
    else positional.push(token);
  });
  return { options, positional };
}

function zoneFromSeatId(seatId) {
  const s = String(seatId || '');
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : '';
}

(async () => {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const seasonCode = positional[0];
  const venueSlug = positional[1];
  if (!seasonCode || !venueSlug) usage();

  const skipSeats = options.has('--skip-seats');
  const skipZones = options.has('--skip-zones');
  if (skipSeats && skipZones) {
    console.log('[instantiate-venue-for-season] Rien à faire (--skip-seats et --skip-zones activés).');
    process.exit(0);
  }

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI ou MONGODB_URI manquant dans l’environnement');
    process.exit(1);
  }

  await mongoose.connect(uri);
  try {
    if (!skipSeats) {
      const templates = await SeatCatalog.find({ venueSlug }).lean();
      if (!templates.length) {
        console.warn(`[instantiate-venue-for-season] Aucun gabarit de siège trouvé pour ${venueSlug}.`);
      } else {
        let created = 0;
        let skipped = 0;
        for (const tpl of templates) {
          const seatId = tpl?.seatId;
          if (!seatId) {
            skipped++;
            continue;
          }
          const zoneKey = tpl?.zoneKey || zoneFromSeatId(seatId);
          const res = await Seat.updateOne(
            { seasonCode, venueSlug, seatId },
            {
              $setOnInsert: {
                status: 'available',
                provisionedFor: null
              },
              $set: { zoneKey }
            },
            { upsert: true }
          );
          if (res.upsertedCount && res.upsertedCount > 0) created++;
          else skipped++;
        }
        console.log(`[instantiate-venue-for-season] Seats → created=${created} skipped=${skipped} (templates=${templates.length})`);
      }
    }

    if (!skipZones) {
      const zones = await ZoneCatalog.find({ venueSlug }).lean();
      if (!zones.length) {
        console.warn(`[instantiate-venue-for-season] Aucun gabarit de zone trouvé pour ${venueSlug}.`);
      } else {
        let upserts = 0;
        let skipped = 0;
        for (const zone of zones) {
          const key = (zone?.key || '').trim().toUpperCase();
          if (!key) {
            skipped++;
            continue;
          }
          const res = await Zone.updateOne(
            { seasonCode, venueSlug, key },
            {
              $set: {
                seasonCode,
                venueSlug,
                key,
                name: zone.name || key,
                type: zone.type || 'seated',
                access: zone.access || 'PUBLIC',
                capacity: zone.capacity ?? 0,
                quota: zone.quota ?? 0,
                svgSelector: zone.svgSelector || null,
                isActive: zone.isActive !== false
              }
            },
            { upsert: true }
          );
          if (res.upsertedCount && res.upsertedCount > 0) upserts++;
          else skipped++;
        }
        console.log(`[instantiate-venue-for-season] Zones → upserts=${upserts} skipped=${skipped} (templates=${zones.length})`);
      }
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('[instantiate-venue-for-season] Erreur:', err);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
