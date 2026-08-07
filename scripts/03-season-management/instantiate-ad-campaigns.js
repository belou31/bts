#!/usr/bin/env node
/**
 * Instantiate ad placements for a season from one or more catalog slugs.
 *
 * Usage:
 *   node scripts/03-season-management/instantiate-ad-campaigns.js <seasonCode> <venueSlug> --catalog=<slug[,slug2,...]>
 *     [--clear] [--dry-run]
 *
 * Behaviour:
 *   - Loads entries from AdCampaignCatalog (global + venue-specific) for each provided slug.
 *   - Upserts AdCampaignPlacement documents for the given seasonCode + venueSlug (priceTableKey: null).
 *   - Use --clear to remove existing season-scoped AdCampaignPlacement rows first.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import { AdCampaignCatalog } from '../../src/models/AdCampaignCatalog.js';
import { AdCampaignPlacement } from '../../src/models/AdCampaignPlacement.js';

dotenv.config();

function usage() {
  console.error('Usage: node scripts/03-season-management/instantiate-ad-campaigns.js <seasonCode> <venueSlug> --catalog=<slug[,slug2,...]> [--clear] [--dry-run]');
  process.exit(1);
}

function optionValue(argv, name) {
  const prefix = `--${name}=`;
  const found = argv.find(token => token.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

(async () => {
  const argv = process.argv.slice(2);
  const seasonCode = argv[0];
  const venueSlug = argv[1];
  if (!seasonCode || !venueSlug) usage();

  const catalogOpt = optionValue(argv, 'catalog');
  if (!catalogOpt) usage();
  const catalogSlugs = catalogOpt.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!catalogSlugs.length) usage();

  const clear = hasFlag(argv, 'clear');
  const dryRun = hasFlag(argv, 'dry-run');

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGO_URI (ou MONGODB_URI) manquant dans l’environnement');
    process.exit(1);
  }
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(mongoUri, connectOpts);

  if (clear && !dryRun) {
    const delRes = await AdCampaignPlacement.deleteMany({ seasonCode, venueSlug, priceTableKey: null });
    console.log(`[instantiate-ad-campaigns] Cleared ${delRes.deletedCount} AdCampaignPlacement rows for season=${seasonCode} venue=${venueSlug}`);
  }

  // Collect entries: global first, venue-specific overrides afterwards
  const entryMap = new Map(); // key => row
  for (const slug of catalogSlugs) {
    const globalDocs = await AdCampaignCatalog.find({ catalogSlug: slug, venueSlug: null }).lean();
    for (const doc of globalDocs) {
      const key = `${doc.campaignSlug}::${doc.slot}::${doc.tariffCode || ''}::${doc.zoneKey || ''}::${doc.zoneType || ''}`;
      if (!entryMap.has(key)) entryMap.set(key, doc);
    }
    const venueDocs = await AdCampaignCatalog.find({ catalogSlug: slug, venueSlug }).lean();
    for (const doc of venueDocs) {
      const key = `${doc.campaignSlug}::${doc.slot}::${doc.tariffCode || ''}::${doc.zoneKey || ''}::${doc.zoneType || ''}`;
      entryMap.set(key, doc);
    }
  }

  if (!entryMap.size) {
    console.warn('[instantiate-ad-campaigns] Aucun placement trouvé dans les catalogues fournis.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const entries = Array.from(entryMap.values());

  if (dryRun) {
    console.log(`[instantiate-ad-campaigns] Dry-run terminé. Placements ready=${entries.length}.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  let upserts = 0;
  for (const entry of entries) {
    const filter = {
      seasonCode,
      venueSlug,
      priceTableKey: null,
      campaignSlug: entry.campaignSlug,
      slot: entry.slot,
      tariffCode: entry.tariffCode || null,
      zoneKey: entry.zoneKey || null,
      zoneType: entry.zoneType || null
    };
    const setDoc = {
      ...filter,
      contentType: entry.contentType,
      qrValue: entry.qrValue || null,
      text: entry.text || null,
      priority: Number.isFinite(entry.priority) ? entry.priority : 100,
      startsAt: entry.startsAt || null,
      endsAt: entry.endsAt || null,
      active: entry.active !== false
    };
    const res = await AdCampaignPlacement.updateOne(filter, { $set: setDoc }, { upsert: true });
    if ((res.upsertedCount ?? 0) > 0 || (res.modifiedCount ?? 0) > 0) upserts++;
  }

  console.log(`[instantiate-ad-campaigns] Upserts=${upserts} (entries processed=${entries.length}) for season=${seasonCode} venue=${venueSlug}`);

  await mongoose.disconnect();
  process.exit(0);
})().catch(async err => {
  console.error('[instantiate-ad-campaigns] Erreur:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
