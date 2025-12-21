#!/usr/bin/env node
/**
 * Instantiate a venue for a given event (delegates to the season/venue metadata).
 *
 * Usage:
 *   node scripts/04-event-management/instantiate-venue-for-event.js --event=<slug|ObjectId> [--skip-seats] [--skip-zones] [--venue-view=<slug>]
 *
 * Behaviour:
 *   - Loads the event to resolve seasonCode and venueSlug.
 *   - Clones SeatCatalog templates into Seat for that season/venue (unless --skip-seats).
 *   - Upserts ZoneCatalog entries into Zone for that season/venue (unless --skip-zones).
 *   - If --venue-view is provided, stores it on the Event document (empty string clears).
 */

import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';

import { Event } from '../../src/models/Event.js';
import { Seat } from '../../src/models/Seat.js';
import { Zone } from '../../src/models/Zone.js';
import { SeatCatalog } from '../../src/models/SeatCatalog.js';
import { ZoneCatalog } from '../../src/models/ZoneCatalog.js';

dotenv.config();

const argv = yargs(hideBin(process.argv))
  .option('event', { type: 'string', demandOption: true, desc: 'Slug ou ObjectId de l’événement' })
  .option('venue', { type: 'string', desc: 'Slug du lieu à associer' })
  .option('skip-seats', { type: 'boolean', default: false, desc: 'Ne pas cloner les sièges' })
  .option('skip-zones', { type: 'boolean', default: false, desc: 'Ne pas cloner les zones' })
  .option('venue-view', { alias: 'venueView', type: 'string', desc: 'Vue plan à associer à l’événement (laisser vide pour effacer)' })
  .help()
  .argv;

function zoneFromSeatId(seatId) {
  const s = String(seatId || '');
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : '';
}

const eventRef = String(argv.event || '').trim();
const skipSeats = argv['skip-seats'] === true;
const skipZones = argv['skip-zones'] === true;
const hasVenueView = Object.prototype.hasOwnProperty.call(argv, 'venueView');
const venueViewValue = hasVenueView ? String(argv.venueView || '').trim() : null;
const venueSlugInput = argv.venue ? String(argv.venue).trim() : null;

if (!eventRef) {
  console.error('❌ Fournir --event=<slug|ObjectId>');
  process.exit(1);
}
if (skipSeats && skipZones && !hasVenueView) {
  console.log('[instantiate-venue-for-event] Rien à faire (--skip-seats et --skip-zones activés, aucune vue fournie).');
  process.exit(0);
}

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!mongoUri) {
  console.error('❌ MONGO_URI ou MONGODB_URI manquant');
  process.exit(1);
}

const connectOpts = {};
if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
await mongoose.connect(mongoUri, connectOpts);

try {
  const event = await (async () => {
    if (/^[0-9a-f]{24}$/i.test(eventRef)) return Event.findById(eventRef).lean();
    return Event.findOne({ slug: eventRef }).lean();
  })();
  if (!event) throw new Error('Événement introuvable');

  let venueSlug = event.venueSlug || venueSlugInput || null;
  if (!venueSlug) {
    throw new Error('Aucun venueSlug trouvé. Fournissez --venue=<slug> ou complétez l’événement.');
  }

  const setPayload = {};
  if (venueSlug && venueSlug !== event.venueSlug) setPayload.venueSlug = venueSlug;

  if (hasVenueView) {
    const newView = venueViewValue || null;
    setPayload.venueView = newView;
  }

  if (Object.keys(setPayload).length) {
    await Event.updateOne({ _id: event._id }, { $set: setPayload });
    if (setPayload.venueSlug) {
      console.log(`[instantiate-venue-for-event] venueSlug défini sur "${setPayload.venueSlug}"`);
      venueSlug = setPayload.venueSlug;
    }
    if (hasVenueView) {
      console.log(`[instantiate-venue-for-event] venueView ${setPayload.venueView ? `définie sur "${setPayload.venueView}"` : 'réinitialisée (null)'}`);
    }
  }

  const seasonCode = event.seasonCode;

  if (!seasonCode || !venueSlug) {
    throw new Error('L’événement ne référence pas seasonCode/venueSlug.');
  }

  if (!skipSeats) {
    const templates = await SeatCatalog.find({ venueSlug }).lean();
    if (!templates.length) {
      console.warn(`[instantiate-venue-for-event] Aucun gabarit de siège trouvé pour ${venueSlug}.`);
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
        if ((res.upsertedCount ?? 0) > 0) created++;
        else skipped++;
      }
      console.log(`[instantiate-venue-for-event] Seats → created=${created} skipped=${skipped} (templates=${templates.length})`);
    }
  }

  if (!skipZones) {
    const zones = await ZoneCatalog.find({ venueSlug }).lean();
    if (!zones.length) {
      console.warn(`[instantiate-venue-for-event] Aucun gabarit de zone trouvé pour ${venueSlug}.`);
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
        if ((res.upsertedCount ?? 0) > 0) upserts++;
        else skipped++;
      }
      console.log(`[instantiate-venue-for-event] Zones → upserts=${upserts} skipped=${skipped} (templates=${zones.length})`);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
} catch (err) {
  console.error('[instantiate-venue-for-event] Erreur:', err.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
}
