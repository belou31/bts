#!/usr/bin/env node
/**
 * Removes the instantiated season-scoped TariffPrice rows for one
 * (seasonCode, venueSlug) pair — subscription pricing, identified by
 * priceTableKey:null + seasonCode + venueSlug on the document itself
 * (see scripts/03-season-management/instantiate-tariffs.js). Different
 * addressing scheme from event tariffs (which use a non-null priceTableKey)
 * — see remove-event-tariffs.js for those, and remove-price-catalog.js for
 * the reusable TariffPriceCatalog templates these are instantiated from.
 *
 * Usage:
 *   node scripts/03-season-management/remove-season-tariffs.js --season=<code> --venue=<slug> --force [--dry-run]
 *
 * "In use" check: warns (and requires --allow-active-season to proceed) if
 * the Season is currently marked active — deleting pricing for a season
 * still open for subscription purchases would break new sales until
 * tariffs are re-instantiated. Existing paid orders keep their own captured
 * totalCents/line prices regardless, so past orders are never at risk.
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { Season } from '../../src/models/Season.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';
import { Order } from '../../src/models/Order.js';

const argv = yargs(hideBin(process.argv))
  .option('season', { type: 'string', demandOption: true, desc: 'Code saison' })
  .option('venue', { type: 'string', demandOption: true, desc: 'Slug du lieu' })
  .option('force', { type: 'boolean', default: false, desc: 'Requis pour la suppression réelle' })
  .option('allow-active-season', { type: 'boolean', default: false, desc: 'Autorise la suppression même si la saison est active' })
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

  const season = await Season.findOne({ code: seasonCode }).lean();
  const priceCount = await TariffPrice.countDocuments(match);
  const subOrderCount = await Order.countDocuments({ seasonCode, venueSlug, eventId: null });

  console.log(`→ Saison: ${seasonCode} (active=${season ? season.active : 'saison introuvable'}) · venue=${venueSlug}`);
  console.log(`  TariffPrice: ${priceCount} · Commandes d'abonnement existantes: ${subOrderCount}`);

  if (!priceCount) {
    console.log('ℹ Aucune ligne trouvée — rien à supprimer.');
    await mongoose.disconnect();
    return;
  }

  if (argv['dry-run']) {
    console.log('\n🧪 Dry-run — rien n\'est supprimé.');
    await mongoose.disconnect();
    return;
  }

  if (season?.active && !argv['allow-active-season']) {
    console.error('\n❌ Refusé: cette saison est active. Ajoutez --allow-active-season pour confirmer explicitement (les ventes d\'abonnement pour ce lieu échoueront jusqu\'à ré-instanciation).');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  if (!argv.force) {
    console.error('\n❌ Refusé: ajoutez --force pour confirmer la suppression.');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const res = await TariffPrice.deleteMany(match);
  console.log(`\n✅ TariffPrice supprimés: ${res.deletedCount}`);
  console.log(`ℹ Les ${subOrderCount} commande(s) d'abonnement existante(s) ne sont pas affectées (prix déjà capturés à l'achat).`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message || e);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
