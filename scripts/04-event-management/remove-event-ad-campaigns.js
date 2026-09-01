#!/usr/bin/env node
/**
 * Removes the instantiated AdCampaignPlacement rows for one event's priceTableKey —
 * the live ad targeting that event actually uses, as opposed to an
 * AdCampaignCatalog template (see remove-ad-campaign-catalog.js). Does NOT
 * touch AdCampaign masters (asset/targetUrl) or delete the event itself.
 *
 * Usage:
 *   node scripts/04-event-management/remove-event-ad-campaigns.js --event=<slug|id> --force [--dry-run]
 *
 * Refused if another event shares this priceTableKey (a custom/shared table
 * isn't this event's alone to remove) — same guard as remove-event-tariffs.js.
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { Event } from '../../src/models/Event.js';
import { AdCampaignPlacement } from '../../src/models/AdCampaignPlacement.js';

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
  const placementCount = await AdCampaignPlacement.countDocuments({ priceTableKey: ev.priceTableKey });

  console.log(`→ Event: ${ev.slug} (${ev._id}) · priceTableKey=${ev.priceTableKey}`);
  console.log(`  AdCampaignPlacement: ${placementCount}`);

  if (!placementCount) {
    console.log('ℹ Aucun placement trouvé — rien à supprimer.');
    await mongoose.disconnect();
    return;
  }

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

  const res = await AdCampaignPlacement.deleteMany({ priceTableKey: ev.priceTableKey });
  console.log(`\n✅ AdCampaignPlacement supprimés: ${res.deletedCount}`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message || e);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
