#!/usr/bin/env node
/**
 * Deletes an AdCampaign master (identity/asset/targetUrl) by slug, AND its
 * staged asset file(s) under data/assets/ads/ — including a whole
 * family/carousel folder if this campaign used one (removed once empty).
 * Any individual file still referenced by another campaign's assetPaths is
 * kept. Does NOT touch AdCampaignCatalog/AdCampaignPlacement rows
 * referencing it — those are a soft reference (same relationship
 * TariffPriceCatalog.tariffCode has to Tariff.code), so any placement still
 * pointing at this slug will simply stop resolving an asset at render time
 * until the campaign is recreated.
 *
 * Usage:
 *   node scripts/02-ticket-ad-management/remove-ad-campaign.js --slug=<slug> --force [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { AdCampaign } from '../../src/models/AdCampaign.js';
import { AdCampaignCatalog } from '../../src/models/AdCampaignCatalog.js';
import { AdCampaignPlacement } from '../../src/models/AdCampaignPlacement.js';

const argv = yargs(hideBin(process.argv))
  .option('slug', { type: 'string', demandOption: true, desc: 'Slug de la campagne à supprimer' })
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

  const slug = String(argv.slug).trim().toLowerCase();
  const campaign = await AdCampaign.findOne({ slug }).lean();
  if (!campaign) {
    console.log(`ℹ Aucune campagne trouvée pour slug=${slug}.`);
    await mongoose.disconnect();
    return;
  }

  const catalogRefs = await AdCampaignCatalog.countDocuments({ campaignSlug: slug });
  const liveRefs = await AdCampaignPlacement.countDocuments({ campaignSlug: slug });

  const assetCount = campaign.assetPaths?.length || 0;
  console.log(`→ slug=${slug} · asset=${campaign.assetKind || '∅'} (${assetCount} fichier(s)) · targetUrl=${campaign.targetUrl || '∅'}`);
  if (catalogRefs || liveRefs) {
    console.log(`  ⚠ Référencée par ${catalogRefs} ligne(s) de catalogue et ${liveRefs} placement(s) instancié(s) — ces lignes ne sont pas supprimées, elles cesseront simplement de résoudre un asset.`);
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

  await AdCampaign.deleteOne({ slug });

  const assetPaths = campaign.assetPaths || [];
  if (assetPaths.length) {
    const others = await AdCampaign.find({ slug: { $ne: slug }, assetPaths: { $in: assetPaths } })
      .select({ assetPaths: 1 }).lean();
    const sharedPaths = new Set(others.flatMap(o => o.assetPaths || []));

    const ADS_DIR = path.resolve(process.cwd(), 'data', 'assets', 'ads');
    const parentDirs = new Set();
    let deleted = 0;
    let kept = 0;
    for (const relPath of assetPaths) {
      const fullPath = path.resolve(process.cwd(), 'data', 'assets', relPath);
      parentDirs.add(path.dirname(fullPath));
      if (sharedPaths.has(relPath)) { kept++; continue; }
      try {
        fs.unlinkSync(fullPath);
        deleted++;
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`⚠ Impossible de supprimer data/assets/${relPath}: ${e.message}`);
      }
    }
    // Clean up a now-empty family/carousel folder (never the shared ads/ root).
    for (const dir of parentDirs) {
      if (dir === ADS_DIR) continue;
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch { /* ignore */ }
    }
    if (deleted) console.log(`✓ ${deleted} asset(s) supprimé(s)`);
    if (kept) console.log(`ℹ ${kept} asset(s) conservé(s) — encore référencé(s) par une autre campagne.`);
  }

  console.log(`\n✅ Campagne "${slug}" supprimée.`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message || e);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
