#!/usr/bin/env node
/**
 * Retire UN tarif global (catalogue, priceTableKey null), s'il n'est utilisé
 * nulle part.
 *
 * Usage:
 *   node scripts/02-tariff-management/remove-global-tariff.js --code=<CODE> [--dry-run]
 *
 * Refusé si le code apparaît dans :
 *   - un catalogue de prix (TariffPriceCatalog) ;
 *   - la table de prix d'un événement (copie Tariff instanciée) ;
 *   - les prix de saison (TariffPrice sans priceTableKey) ;
 *   - une ligne de commande — les commandes passées gardent leur tarif.
 * Le détail des usages est affiché. Les copies instanciées ne sont jamais
 * touchées : seul le tarif global est supprimé.
 *
 * Signalé sans bloquer : le code cité dans data/customization (partners.json,
 * cart-rules.json…), à retirer à la main s'il disparaît.
 *
 * Environment: MONGO_URI or MONGODB_URI (required), MONGODB_DB (optional)
 */
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

import { Tariff } from '../../src/models/Tariff.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';
import { TariffPriceCatalog } from '../../src/models/TariffPriceCatalog.js';
import { Order } from '../../src/models/Order.js';

dotenv.config();

const args = process.argv.slice(2);
const codeArg = args.find(a => a.startsWith('--code='));
const code = codeArg ? codeArg.slice('--code='.length).trim().toUpperCase() : '';
const dryRun = args.includes('--dry-run');
if (!code) {
  console.error('Usage: node scripts/02-tariff-management/remove-global-tariff.js --code=<CODE> [--dry-run]');
  process.exit(1);
}

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) { console.error('❌ MONGO_URI/MONGODB_URI manquant'); process.exit(1); }
await mongoose.connect(uri, process.env.MONGODB_DB ? { dbName: process.env.MONGODB_DB } : {});

try {
  const global = await Tariff.findOne({ code, priceTableKey: null }).lean();
  if (!global) {
    console.error(`❌ Aucun tarif global « ${code} ».`);
    process.exitCode = 1;
  } else {
    console.log(`→ ${code} — ${global.label} (canaux : ${(global.channels || ['public']).join(', ')})`);

    const [catalogs, events, seasonPrices, orderLines] = await Promise.all([
      TariffPriceCatalog.distinct('catalogSlug', { tariffCode: code }),
      Tariff.distinct('priceTableKey', { code, priceTableKey: { $type: 'string' } }),
      TariffPrice.aggregate([{ $match: { tariffCode: code, priceTableKey: null } },
        { $group: { _id: { season: '$seasonCode', venue: '$venueSlug' } } }]),
      Order.aggregate([{ $unwind: '$lines' }, { $match: { 'lines.tariffCode': code } },
        { $group: { _id: null, lines: { $sum: 1 }, orders: { $addToSet: '$_id' } } }])
    ]);
    const usages = [];
    if (catalogs.length) usages.push(`catalogue(s) de prix : ${catalogs.join(', ')}`);
    if (events.length) usages.push(`table(s) d'événement : ${events.join(', ')}`);
    if (seasonPrices.length) usages.push(`prix de saison : ${seasonPrices.map(r => `${r._id.season}/${r._id.venue}`).join(', ')}`);
    if (orderLines.length) usages.push(`commandes : ${orderLines[0].orders.length} commande(s), ${orderLines[0].lines} ligne(s)`);

    // Configuration citant le code : à nettoyer à la main, sans bloquer.
    const custoDir = path.resolve(process.cwd(), 'data', 'customization');
    const re = new RegExp(`"${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i');
    const cited = fs.existsSync(custoDir)
      ? fs.readdirSync(custoDir, { recursive: true })
        .filter(f => String(f).endsWith('.json'))
        .filter(f => re.test(fs.readFileSync(path.join(custoDir, String(f)), 'utf8')))
      : [];

    if (usages.length) {
      console.error(`❌ Refusé : « ${code} » est utilisé —`);
      usages.forEach(u => console.error(`   • ${u}`));
      console.error('   Retirez-le de ces emplois d\'abord (ou laissez-le, inactif, en le réimportant avec active=false).');
      process.exitCode = 1;
    } else {
      if (cited.length) console.warn(`⚠ Cité dans data/customization : ${cited.join(', ')} — à retirer à la main.`);
      if (dryRun) {
        console.log(`✓ Dry-run : « ${code} » n'est utilisé nulle part, il serait supprimé.`);
      } else {
        const r = await Tariff.deleteOne({ code, priceTableKey: null });
        console.log(`✓ Tarif global « ${code} » supprimé (${r.deletedCount}).`);
      }
    }
  }
} finally {
  await mongoose.disconnect();
}
