#!/usr/bin/env node
/**
 * Removes the instantiated Tariff/TariffPrice rows for one event's
 * priceTableKey — the live pricing that event actually uses, as opposed to
 * a TariffPriceCatalog template (see remove-price-catalog.js). Does NOT
 * delete the event itself (see delete-event.js for that).
 *
 * Usage:
 *   node scripts/04-event-management/remove-event-tariffs.js --event=<slug|id> --force [--dry-run]
 *
 * "In use" check that actually means something here: if another event
 * shares this priceTableKey (a custom/shared table via --price-table),
 * deletion is refused — that table isn't this event's alone to remove.
 * Existing paid orders for this event already have their own totalCents/
 * line prices captured at purchase time, so removing the live price table
 * afterward doesn't corrupt past orders — it just means the event can't be
 * purchased from until tariffs are re-instantiated.
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { Event } from '../../src/models/Event.js';
import { Tariff } from '../../src/models/Tariff.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';

const argv = yargs(hideBin(process.argv))
  .option('event', { type: 'string', demandOption: true, desc: 'Slug ou ObjectId de l\'événement' })
  .option('force', { type: 'boolean', default: false, desc: 'Requis pour la suppression réelle' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Aperçu sans écriture' })
  .help()
  .argv;

function resolveEventQuery(ref) {
  return /^[0-9a-f]{24}$/i.test(ref) ? { _id: ref } : { slug: ref };
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI/MONGODB_URI manquant');
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  const ev = await Event.findOne(resolveEventQuery(String(argv.event).trim())).lean();
  if (!ev) throw new Error(`Événement introuvable: ${argv.event}`);
  if (!ev.priceTableKey) {
    console.log('ℹ Cet événement n\'a pas de priceTableKey — rien à supprimer.');
    await mongoose.disconnect();
    return;
  }

  const sharingEvents = await Event.find({ priceTableKey: ev.priceTableKey, _id: { $ne: ev._id } }).select({ slug: 1 }).lean();
  const tariffCount = await Tariff.countDocuments({ priceTableKey: ev.priceTableKey });
  const priceCount = await TariffPrice.countDocuments({ priceTableKey: ev.priceTableKey });

  console.log(`→ Event: ${ev.slug} (${ev._id}) · priceTableKey=${ev.priceTableKey}`);
  console.log(`  Tariff: ${tariffCount} · TariffPrice: ${priceCount}`);

  if (sharingEvents.length) {
    console.error(`\n❌ Refusé: priceTableKey "${ev.priceTableKey}" est aussi utilisé par: ${sharingEvents.map(e => e.slug).join(', ')} — ce n'est pas une table propre à cet événement.`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  if (argv['dry-run']) {
    console.log('\n🧪 Dry-run — rien n\'est supprimé.');
    await mongoose.disconnect();
    return;
  }

  if (!argv.force) {
    console.error('\n❌ Refusé: ajoutez --force pour confirmer la suppression.');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const tarDel = await Tariff.deleteMany({ priceTableKey: ev.priceTableKey });
  const priceDel = await TariffPrice.deleteMany({ priceTableKey: ev.priceTableKey });
  console.log(`\n✅ Tariff supprimés: ${tarDel.deletedCount} · TariffPrice supprimés: ${priceDel.deletedCount}`);
  console.log(`ℹ "${ev.slug}" n'a plus de tarifs — instantiate-tariffs.js pour en recréer avant remise en vente.`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message || e);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
