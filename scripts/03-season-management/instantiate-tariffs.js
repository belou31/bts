#!/usr/bin/env node
/**
 * Instantiate tariff prices for a season from one or more catalog slugs.
 *
 * Usage:
 *   node scripts/03-season-management/instantiate-tariffs.js <seasonCode> <venueSlug> --catalog=<slug[,slug2,...]>
 *     [--clear] [--dry-run] [--skip-tariff-check]
 *
 * Behaviour:
 *   - Loads entries from TariffPriceCatalog (global + venue-specific) for each provided slug.
 *   - Upserts TariffPrice documents for the given seasonCode + venueSlug.
 *   - Use --clear to remove existing TariffPrice rows for the season/venue before upserting.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import { Tariff } from '../../src/models/Tariff.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';
import { TariffPriceCatalog } from '../../src/models/TariffPriceCatalog.js';

dotenv.config();

function usage() {
  console.error('Usage: node scripts/03-season-management/instantiate-tariffs.js <seasonCode> <venueSlug> --catalog=<slug[,slug2,...]> [--clear] [--dry-run] [--skip-tariff-check]');
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
  const skipTariffCheck = hasFlag(argv, 'skip-tariff-check');

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGO_URI (ou MONGODB_URI) manquant dans l’environnement');
    process.exit(1);
  }
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(mongoUri, connectOpts);

  if (clear && !dryRun) {
    const delRes = await TariffPrice.deleteMany({ seasonCode, venueSlug, priceTableKey: null });
    console.log(`[instantiate-tariffs] Cleared ${delRes.deletedCount} TariffPrice rows for season=${seasonCode} venue=${venueSlug}`);
  }

  // Collect entries: global first, venue-specific overrides afterwards
  const entryMap = new Map(); // key => { priceCents, catalogSlug, channels }
  for (const slug of catalogSlugs) {
    const globalDocs = await TariffPriceCatalog.find({ catalogSlug: slug, venueSlug: null }).lean();
    for (const doc of globalDocs) {
      const key = `${doc.zoneKey}::${doc.tariffCode}`;
      if (!entryMap.has(key)) {
        entryMap.set(key, { priceCents: doc.priceCents, catalogSlug: slug, channels: doc.channels });
      }
    }
    const venueDocs = await TariffPriceCatalog.find({ catalogSlug: slug, venueSlug }).lean();
    for (const doc of venueDocs) {
      const key = `${doc.zoneKey}::${doc.tariffCode}`;
      entryMap.set(key, { priceCents: doc.priceCents, catalogSlug: slug, channels: doc.channels });
    }
  }

  if (!entryMap.size) {
    console.warn('[instantiate-tariffs] Aucun tarif trouvé dans les catalogues fournis.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const entries = Array.from(entryMap.entries()).map(([key, value]) => {
    const [zoneKey, tariffCode] = key.split('::');
    return {
      zoneKey,
      tariffCode,
      priceCents: value.priceCents,
      catalogSlug: value.catalogSlug,
      channels: value.channels
    };
  });

  if (!skipTariffCheck) {
    const uniqueTariffs = [...new Set(entries.map(e => e.tariffCode))];
    const knownTariffs = await Tariff.find({ code: { $in: uniqueTariffs } }).select({ code: 1 }).lean();
    const knownSet = new Set(knownTariffs.map(t => t.code));
    const missing = uniqueTariffs.filter(code => !knownSet.has(code));
    if (missing.length) {
      console.warn(`[instantiate-tariffs] Attention: ${missing.length} tarifs absents du catalogue Tariff: ${missing.join(', ')}`);
    }
  }

  if (dryRun) {
    console.log(`[instantiate-tariffs] Dry-run terminé. Tariffs ready=${entries.length}.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  let upserts = 0;
  for (const entry of entries) {
    const setDoc = {
      seasonCode,
      venueSlug,
      zoneKey: entry.zoneKey,
      tariffCode: entry.tariffCode,
      priceCents: entry.priceCents,
      priceTableKey: null
    };
    const updateDoc = { $set: setDoc };
    if (entry.channels && entry.channels.length) {
      setDoc.channels = entry.channels;
    } else {
      updateDoc.$unset = { channels: '' };
    }
    const res = await TariffPrice.updateOne(
      { seasonCode, venueSlug, zoneKey: entry.zoneKey, tariffCode: entry.tariffCode, priceTableKey: null },
      updateDoc,
      { upsert: true }
    );
    if ((res.upsertedCount ?? 0) > 0 || (res.modifiedCount ?? 0) > 0) upserts++;
  }

  console.log(`[instantiate-tariffs] Upserts=${upserts} (entries processed=${entries.length}) for season=${seasonCode} venue=${venueSlug}`);

  await mongoose.disconnect();
  process.exit(0);
})().catch(async err => {
  console.error('[instantiate-tariffs] Erreur:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
