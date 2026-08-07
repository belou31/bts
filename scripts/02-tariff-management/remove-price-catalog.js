#!/usr/bin/env node
/**
 * Removes TariffPriceCatalog rows for a given catalogSlug (+ optional venue
 * scope). This is the reusable TEMPLATE catalog, not any event/season's
 * live pricing — instantiate-tariffs.js COPIES rows from here once, and the
 * copy is never linked back (TariffPrice doesn't even store catalogSlug), so
 * deleting a catalog template cannot retroactively affect any event or
 * season that already instantiated from it. The only real consequence is
 * forward-looking: instantiate-tariffs.js --catalog=<this slug> will fail
 * cleanly for any future event/season until the catalog is recreated.
 *
 * Usage:
 *   node scripts/02-tariff-management/remove-price-catalog.js --catalog=<slug> [--venue=<slug>] --force [--dry-run]
 *
 * Without --venue, removes every venue scope for that catalogSlug (global
 * rows with venueSlug=null AND every venue-specific override) — use --venue
 * to remove just one venue's rows and leave the rest of the catalog intact.
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { TariffPriceCatalog } from '../../src/models/TariffPriceCatalog.js';

const argv = yargs(hideBin(process.argv))
  .option('catalog', { type: 'string', demandOption: true, desc: 'catalogSlug à supprimer' })
  .option('venue', { type: 'string', desc: 'Limiter à un lieu (sinon toutes les portées de ce catalogSlug)' })
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

  const catalogSlug = String(argv.catalog).trim().toLowerCase();
  const match = { catalogSlug };
  if (argv.venue !== undefined) match.venueSlug = argv.venue ? String(argv.venue).trim() : null;

  const rows = await TariffPriceCatalog.find(match).lean();
  if (!rows.length) {
    console.log(`ℹ Aucune ligne trouvée pour catalogSlug=${catalogSlug}${argv.venue !== undefined ? ` venue=${match.venueSlug || '(global)'}` : ''}.`);
    await mongoose.disconnect();
    return;
  }

  const venueScopes = [...new Set(rows.map(r => r.venueSlug || '(global)'))];
  const zones = [...new Set(rows.map(r => r.zoneKey))];
  const tariffs = [...new Set(rows.map(r => r.tariffCode))];
  const prices = rows.map(r => r.priceCents);

  console.log(`→ catalogSlug=${catalogSlug} · ${rows.length} ligne(s) · venues=[${venueScopes.join(', ')}] · zones=[${zones.join(', ')}] · tarifs=[${tariffs.join(', ')}]`);
  console.log(`  Prix: ${(Math.min(...prices) / 100).toFixed(2)}€ – ${(Math.max(...prices) / 100).toFixed(2)}€`);
  console.log('  Sûr par construction : aucun événement/saison déjà instancié depuis ce catalogue ne peut être affecté (TariffPrice ne conserve pas de lien vers le catalogue source).');

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

  const res = await TariffPriceCatalog.deleteMany(match);
  console.log(`\n✅ ${res.deletedCount} ligne(s) supprimée(s) pour catalogSlug=${catalogSlug}.`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message || e);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
