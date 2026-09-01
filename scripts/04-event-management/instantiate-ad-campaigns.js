#!/usr/bin/env node
/**
 * Instantiate ad placements for an event.
 *
 * Usage:
 *   node scripts/04-event-management/instantiate-ad-campaigns.js --event=<slug>
 *     --catalog=sponsors-2026[,sponsors-2026-extra]
 *     [--clear] [--dry-run] [--set-theme=<value>]
 *
 * Behaviour:
 *   - Loads AdCampaignCatalog rows (global + venue-specific) for each catalog slug.
 *   - Upserts AdCampaignPlacement documents scoped to the event's priceTableKey.
 *   - Use --clear to remove existing AdCampaignPlacement rows for that priceTableKey before upserting.
 *   - --set-theme=<value>: also sets Event.templateTheme (see set-event-theme.js),
 *     so this event's ticket/email switch to the matching themed template —
 *     opt-in, not automatic; omit to leave the event's template untouched.
 *
 * Does not touch AdCampaign masters (asset/targetUrl) — see set-ad-campaign.js.
 */

import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import dotenv from 'dotenv';
dotenv.config();

import { Event } from '../../src/models/Event.js';
import { AdCampaignPlacement } from '../../src/models/AdCampaignPlacement.js';
import { AdCampaignCatalog } from '../../src/models/AdCampaignCatalog.js';

function normalize(value) {
  return String(value || '').trim();
}

const argv = yargs(hideBin(process.argv))
  .option('event', { type: 'string', demandOption: true, desc: 'Slug ou ObjectId de l\'événement' })
  .option('catalog', { type: 'string', demandOption: true, desc: 'Un ou plusieurs catalogues AdCampaignCatalog (slug[,slug2])' })
  .option('clear', { type: 'boolean', default: false, desc: 'Supprime d\'abord les AdCampaignPlacement existants pour cette table' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Ne fait aucun upsert' })
  .option('set-theme', { type: 'string', desc: 'Définit aussi Event.templateTheme (voir set-event-theme.js) — optionnel' })
  .help()
  .argv;

const eventRef = normalize(argv.event);
const catalogList = normalize(argv.catalog)
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

if (!catalogList.length) {
  console.error('❌ Aucun catalogue fourni (utilisez --catalog=slug[,slug2])');
  process.exit(1);
}

const CLEAR = argv.clear === true;
const DRY_RUN = argv['dry-run'] === true;

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!mongoUri) {
  console.error('❌ MONGO_URI/MONGODB_URI manquant');
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
  if (!event.priceTableKey) throw new Error('priceTableKey absent sur l\'événement');

  console.log(`→ Event: ${event.slug || event._id} · priceTableKey=${event.priceTableKey}`);

  const rowsByKey = new Map(); // key => catalog row (last catalog listed wins on conflict)

  for (const catalogSlug of catalogList) {
    console.log(`→ Lecture catalogue ${catalogSlug}`);
    let docs = await AdCampaignCatalog.find({ catalogSlug, venueSlug: event.venueSlug }).lean();
    if (!docs.length) {
      docs = await AdCampaignCatalog.find({ catalogSlug, venueSlug: null }).lean();
    }
    if (!docs.length) {
      throw new Error(`Catalogue ${catalogSlug} introuvable (aucune entrée pour venue=${event.venueSlug} ou globale)`);
    }
    for (const doc of docs) {
      const key = `${doc.campaignSlug}::${doc.slot}::${doc.tariffCode || ''}::${doc.zoneKey || ''}::${doc.zoneType || ''}`;
      rowsByKey.set(key, doc);
    }
  }

  if (!rowsByKey.size) {
    console.warn('⚠️  Aucun placement collecté depuis les catalogues.');
    process.exit(0);
  }

  const eventPriceTableKey = event.priceTableKey;

  if (CLEAR && !DRY_RUN) {
    const delRes = await AdCampaignPlacement.deleteMany({ priceTableKey: eventPriceTableKey });
    console.log(`→ Clear: AdCampaignPlacement supprimés=${delRes.deletedCount}`);
  }

  // seasonCode/venueSlug are deliberately absent here (not just null) —
  // they're cleared via $unset below, since $set and $unset on the same
  // path in one update conflicts in MongoDB.
  const placementDocs = Array.from(rowsByKey.values()).map(doc => ({
    priceTableKey: eventPriceTableKey,
    campaignSlug: doc.campaignSlug,
    contentType: doc.contentType,
    slot: doc.slot,
    qrValue: doc.qrValue || null,
    text: doc.text || null,
    tariffCode: doc.tariffCode || null,
    zoneKey: doc.zoneKey || null,
    zoneType: doc.zoneType || null,
    priority: Number.isFinite(doc.priority) ? doc.priority : 100,
    startsAt: doc.startsAt || null,
    endsAt: doc.endsAt || null,
    active: doc.active !== false
  }));

  if (DRY_RUN) {
    console.log(`🧪 Dry-run — AdCampaignPlacement à upsert=${placementDocs.length}`);
    process.exit(0);
  }

  let upserts = 0;
  for (const doc of placementDocs) {
    const res = await AdCampaignPlacement.updateOne(
      {
        priceTableKey: eventPriceTableKey,
        campaignSlug: doc.campaignSlug,
        slot: doc.slot,
        tariffCode: doc.tariffCode,
        zoneKey: doc.zoneKey,
        zoneType: doc.zoneType
      },
      { $set: doc, $unset: { seasonCode: '', venueSlug: '' } },
      { upsert: true }
    );
    if ((res.upsertedCount ?? 0) > 0 || (res.modifiedCount ?? 0) > 0) upserts++;
  }

  console.log(`✅ AdCampaignPlacement upserts=${upserts}`);

  if (argv['set-theme']) {
    const nextTheme = String(argv['set-theme']).trim();
    await Event.updateOne({ _id: event._id }, { $set: { templateTheme: nextTheme } });
    console.log(`✅ Event.templateTheme="${nextTheme}" (ticket + email switchent vers ce thème s'il existe)`);
  }

  await mongoose.disconnect();
  process.exit(0);
} catch (err) {
  console.error('❌', err.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
}
