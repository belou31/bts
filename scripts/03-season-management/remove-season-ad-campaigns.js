#!/usr/bin/env node
/**
 * Removes the instantiated season-scoped AdCampaignPlacement rows for one
 * (seasonCode, venueSlug) pair — identified by priceTableKey:null +
 * seasonCode + venueSlug on the document itself (see
 * scripts/03-season-management/instantiate-ad-campaigns.js). Different
 * addressing scheme from event placements (non-null priceTableKey) — see
 * remove-event-ad-campaigns.js for those.
 *
 * Usage:
 *   node scripts/03-season-management/remove-season-ad-campaigns.js --season=<code> --venue=<slug> --force [--dry-run]
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { AdCampaignPlacement } from '../../src/models/AdCampaignPlacement.js';

const argv = yargs(hideBin(process.argv))
  .option('season', { type: 'string', demandOption: true, desc: 'Code saison' })
  .option('venue', { type: 'string', demandOption: true, desc: 'Slug du lieu' })
  .option('force', { type: 'boolean', default: false, desc: 'Requis pour la suppression réelle' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Aperçu sans écriture' })
  .help()
  .argv;

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI/MONGODB_URI manquant');
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  const seasonCode = String(argv.season).trim();
  const venueSlug = String(argv.venue).trim();
  const match = { seasonCode, venueSlug, priceTableKey: null };

  const count = await AdCampaignPlacement.countDocuments(match);
  console.log(`→ Saison: ${seasonCode} · venue=${venueSlug} · AdCampaignPlacement: ${count}`);

  if (!count) {
    console.log('ℹ Aucune ligne trouvée — rien à supprimer.');
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

  const res = await AdCampaignPlacement.deleteMany(match);
  console.log(`\n✅ AdCampaignPlacement supprimés: ${res.deletedCount}`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message || e);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
