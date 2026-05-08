#!/usr/bin/env node
/**
 * Instantiate tariff catalogs for an event.
 *
 * Usage:
 *   node scripts/04-event-management/instantiate-tariffs.js --event=<slug>
 *     --catalog=season-game[,season-club]
 *     [--clear] [--dry-run] [--skip-tariff-check]
 *
 * Behaviour:
 *   - Loads TariffPriceCatalog rows (global + venue-specific) for each catalog slug.
 *   - Upserts Tariff documents scoped to the event's priceTableKey (labels inherited from global Tariff when available).
 *   - Upserts TariffPrice rows for the event price table.
 *   - Use --clear to remove existing Tariff / TariffPrice rows for that priceTableKey before upserting.
 */

import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import dotenv from 'dotenv';
dotenv.config();

import { Event } from '../../src/models/Event.js';
import { Tariff } from '../../src/models/Tariff.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';
import { TariffPriceCatalog } from '../../src/models/TariffPriceCatalog.js';

function normalize(value) {
  return String(value || '').trim();
}
function normalizeCode(value) {
  return normalize(value).toUpperCase();
}

const argv = yargs(hideBin(process.argv))
  .option('event', { type: 'string', demandOption: true, desc: 'Slug ou ObjectId de l\'événement' })
  .option('catalog', { type: 'string', demandOption: true, desc: 'Un ou plusieurs catalogues TariffPriceCatalog (slug[,slug2])' })
  .option('clear', { type: 'boolean', default: false, desc: 'Supprime d\'abord les Tariff/TariffPrice existants pour cette table' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Ne fait aucun upsert' })
  .option('skip-tariff-check', { type: 'boolean', default: false, desc: 'Ignore la vérification des tarifs globaux' })
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
const SKIP_TARIFF_CHECK = argv['skip-tariff-check'] === true;

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

  const entryMap = new Map(); // key => { priceCents, channels }
  const tariffCodes = new Set();

  for (const catalogSlug of catalogList) {
    console.log(`→ Lecture catalogue ${catalogSlug}`);
    let docs = await TariffPriceCatalog.find({ catalogSlug, venueSlug: event.venueSlug }).lean();
    if (!docs.length) {
      docs = await TariffPriceCatalog.find({ catalogSlug, venueSlug: null }).lean();
    }
    if (!docs.length) {
      throw new Error(`Catalogue ${catalogSlug} introuvable (aucune entrée pour venue=${event.venueSlug} ou globale)`);
    }
    for (const doc of docs) {
      const zoneKey = normalizeCode(doc.zoneKey);
      const tariffCode = normalizeCode(doc.tariffCode);
      if (!zoneKey || !tariffCode) continue;
      entryMap.set(`${zoneKey}::${tariffCode}`, {
        priceCents: Number(doc.priceCents) || 0,
        partnerPriceCents: doc.partnerPriceCents != null ? Number(doc.partnerPriceCents) : null,
        currency: doc.currency || 'EUR',
        catalogSlug,
        channels: doc.channels
      });
      tariffCodes.add(tariffCode);
    }
  }

  if (!entryMap.size) {
    console.warn('⚠️  Aucun prix collecté depuis les catalogues.');
    process.exit(0);
  }

  const eventPriceTableKey = event.priceTableKey;

  if (CLEAR && !DRY_RUN) {
    const tarDel = await Tariff.deleteMany({ priceTableKey: eventPriceTableKey });
    const priceDel = await TariffPrice.deleteMany({ priceTableKey: eventPriceTableKey });
    console.log(`→ Clear: Tariff supprimés=${tarDel.deletedCount} · TariffPrice supprimés=${priceDel.deletedCount}`);
  }

  let missingTariffs = [];
  if (!SKIP_TARIFF_CHECK) {
    const codes = Array.from(tariffCodes);
    const existing = await Tariff.find({ priceTableKey: { $in: [null, undefined] }, code: { $in: codes } }).select({ code: 1, label: 1, requiresField: 1, fieldLabel: 1, requiresInfo: 1, sortOrder: 1, active: 1 }).lean();
    const map = new Map(existing.map(t => [normalizeCode(t.code), t]));
    missingTariffs = codes.filter(code => !map.has(code));
    if (missingTariffs.length) {
      console.warn(`⚠️  ${missingTariffs.length} tarifs absents du catalogue global: ${missingTariffs.join(', ')}`);
    }
  }

  const globalTariffs = await Tariff.find({ priceTableKey: { $in: [null, undefined] }, code: { $in: Array.from(tariffCodes) } }).lean();
  const globalMap = new Map(globalTariffs.map(t => [normalizeCode(t.code), t]));

  const tariffDocs = new Map();
  for (const code of tariffCodes) {
    const upper = normalizeCode(code);
    const base = globalMap.get(upper) || {};
    tariffDocs.set(upper, {
      code: upper,
      priceTableKey: eventPriceTableKey,
      label: base.label || upper,
      requiresField: base.requiresField ?? null,
      fieldLabel: base.fieldLabel ?? null,
      requiresInfo: base.requiresInfo ?? null,
      active: base.active !== false,
      sortOrder: base.sortOrder ?? 100,
      channels: base.channels
    });
  }

  const priceDocs = Array.from(entryMap.entries()).map(([key, value]) => {
    const [zoneKey, tariffCode] = key.split('::');
    return {
      priceTableKey: eventPriceTableKey,
      zoneKey,
      tariffCode,
      priceCents: value.priceCents,
      partnerPriceCents: value.partnerPriceCents,
      currency: value.currency || 'EUR',
      channels: value.channels
    };
  });

  if (DRY_RUN) {
    console.log(`🧪 Dry-run — Tariff à upsert=${tariffDocs.size}, TariffPrice=${priceDocs.length}`);
    process.exit(0);
  }

  let tariffUpserts = 0;
  for (const doc of tariffDocs.values()) {
    const setDoc = { ...doc };
    const updateDoc = { $set: setDoc };
    if (!doc.channels || !doc.channels.length) {
      delete setDoc.channels;
      updateDoc.$unset = { channels: '' };
    }
    const res = await Tariff.updateOne(
      { priceTableKey: eventPriceTableKey, code: doc.code },
      updateDoc,
      { upsert: true }
    );
    if ((res.upsertedCount ?? 0) > 0 || (res.modifiedCount ?? 0) > 0) tariffUpserts++;
  }

  let priceUpserts = 0;
  for (const doc of priceDocs) {
    const setDoc = {
      priceTableKey: eventPriceTableKey,
      zoneKey: doc.zoneKey,
      tariffCode: doc.tariffCode,
      priceCents: doc.priceCents,
      currency: doc.currency || 'EUR'
    };
    const updateDoc = {
      $set: setDoc,
      $unset: { seasonCode: '', venueSlug: '' }
    };
    if (doc.partnerPriceCents != null) {
      setDoc.partnerPriceCents = doc.partnerPriceCents;
    } else {
      updateDoc.$unset.partnerPriceCents = '';
    }
    if (doc.channels && doc.channels.length) {
      setDoc.channels = doc.channels;
    } else {
      updateDoc.$unset.channels = '';
    }
    const res = await TariffPrice.updateOne(
      { priceTableKey: eventPriceTableKey, zoneKey: doc.zoneKey, tariffCode: doc.tariffCode },
      updateDoc,
      { upsert: true, setDefaultsOnInsert: true }
    );
    if ((res.upsertedCount ?? 0) > 0 || (res.modifiedCount ?? 0) > 0) priceUpserts++;
  }

  console.log(`✅ Tariffs upserts=${tariffUpserts} · TariffPrice upserts=${priceUpserts}`);
  if (missingTariffs.length) {
    console.log(`ℹ️  Tarifs absents du global: ${missingTariffs.join(', ')}`);
  }

  await mongoose.disconnect();
  process.exit(0);
} catch (err) {
  console.error('❌', err.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
}
