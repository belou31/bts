/**
 * Recrée les index uniques de TariffPrice ET TariffPriceCatalog pour y inclure
 * `metaZone`.
 *
 * Une ligne de prix vise désormais SOIT une zone, SOIT une méta-zone
 * (src/models/TariffPrice.js). Les lignes « méta-zone » ont donc `zoneKey: null`
 * — et sous les anciens index, deux méta-zones différentes au même tarif
 * retombaient sur la même clé (season, venue, null, tariff) : la seconde était
 * rejetée en doublon. Mongoose ne modifie jamais les options d'un index déjà
 * créé, d'où cette migration explicite.
 *
 * Sans elle, rien n'est silencieusement faux : la création d'une deuxième
 * grille par méta-zone échoue en E11000. C'est bruyant, mais bloquant.
 *
 * Usage:
 *   node scripts/migrations/migrate-tariffprice-meta-zone.js          # dry-run
 *   node scripts/migrations/migrate-tariffprice-meta-zone.js --apply
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { TariffPrice } from '../../src/models/TariffPrice.js';
import { TariffPriceCatalog } from '../../src/models/TariffPriceCatalog.js';

import dotenv from 'dotenv';
dotenv.config();

// Les DEUX collections sont concernées : le catalogue réutilisable comme la
// grille instanciée. Oublier le catalogue laisse l'import avaler silencieusement
// la deuxième méta-zone d'un même tarif — constaté en test.
const TARGETS = [
  {
    name: 'uniq_season_venue_zone_tariff',
    key: { seasonCode: 1, venueSlug: 1, zoneKey: 1, metaZone: 1, tariffCode: 1 },
    options: {
      unique: true,
      name: 'uniq_season_venue_zone_tariff',
      partialFilterExpression: { seasonCode: { $type: 'string' }, venueSlug: { $type: 'string' } }
    }
  },
  {
    name: 'uniq_priceTable_zone_tariff',
    key: { priceTableKey: 1, zoneKey: 1, metaZone: 1, tariffCode: 1 },
    options: {
      unique: true,
      name: 'uniq_priceTable_zone_tariff',
      partialFilterExpression: { priceTableKey: { $type: 'string' } }
    }
  }
];

const CATALOG_TARGETS = [
  {
    name: 'uniq_tariff_price_catalog_entry',
    key: { catalogSlug: 1, venueSlug: 1, zoneKey: 1, metaZone: 1, tariffCode: 1 },
    options: { unique: true, name: 'uniq_tariff_price_catalog_entry' }
  }
];

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('apply', { type: 'boolean', default: false, desc: 'Écrit les changements (défaut : dry-run)' })
    .help().argv;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  const opts = {};
  if (process.env.MONGODB_DB) opts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, opts);

  for (const [model, targets, label] of [
    [TariffPrice, TARGETS, 'TariffPrice'],
    [TariffPriceCatalog, CATALOG_TARGETS, 'TariffPriceCatalog']
  ]) {
  console.log(`\n— ${label} —`);
  const before = await model.collection.indexes();
  for (const target of targets) {
    const existing = before.find(i => i.name === target.name);
    const upToDate = existing && sameKey(existing.key, target.key);
    console.log(`${target.name}: ${!existing ? 'absent' : upToDate ? 'déjà à jour' : 'à recréer'}`);
    if (upToDate) continue;

    if (argv.apply) {
      if (existing) {
        await model.collection.dropIndex(target.name);
        console.log(`  · ancien index supprimé`);
      }
      await model.collection.createIndex(target.key, target.options);
      console.log(`  ✅ recréé avec metaZone`);
    }
  }

  if (argv.apply) {
    const after = await model.collection.indexes();
    for (const target of targets) {
      const now = after.find(i => i.name === target.name);
      console.log(`  Vérification ${target.name}: ${now ? JSON.stringify(now.key) : 'ABSENT'} unique=${Boolean(now?.unique)}`);
    }
  }
  }

  if (!argv.apply) {
    console.log('\nDry-run uniquement — relancer avec --apply pour écrire.');
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
