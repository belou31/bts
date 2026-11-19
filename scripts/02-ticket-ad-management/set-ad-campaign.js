#!/usr/bin/env node
/**
 * Defines (or edits) an ad campaign's identity: label, click target,
 * active. Pure identity/metadata — no asset here, see
 * import-ad-campaign-asset.js for staging/attaching the actual creative
 * (SVG/PNG/JPG). Neither script is a prerequisite for the other: a campaign
 * can be registered here first (no image on tickets until an asset is
 * attached) or created directly by import-ad-campaign-asset.js --campaign=.
 *
 * Usage:
 *   node scripts/02-ticket-ad-management/set-ad-campaign.js --slug=<slug>
 *     [--target-url=<url>] [--label="<text>"] [--active=true|false] [--dry-run]
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { AdCampaign } from '../../src/models/AdCampaign.js';

const argv = yargs(hideBin(process.argv))
  .option('slug', { type: 'string', demandOption: true, desc: 'Identité de la campagne (créée si absente)' })
  .option('target-url', { type: 'string', desc: 'Lien sponsor (QR promo) — laisser vide pour ne pas avoir de QR cliquable' })
  .option('label', { type: 'string', desc: 'Nom affiché (optionnel, pour repérage admin)' })
  .option('active', { type: 'boolean', default: true, desc: 'Campagne active' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Aperçu sans écriture' })
  .help()
  .argv;

async function main() {
  const slug = String(argv.slug).trim().toLowerCase();
  if (!slug) throw new Error('--slug manquant');

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI/MONGODB_URI manquant');
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  const existing = await AdCampaign.findOne({ slug }).lean();

  const setDoc = {
    targetUrl: argv['target-url'] || null,
    label: argv.label || null,
    active: argv.active !== false
  };

  if (argv['dry-run']) {
    console.log(`🧪 Dry-run — would ${existing ? 'update' : 'create'} AdCampaign slug="${slug}":`, setDoc);
    await mongoose.disconnect();
    return;
  }

  await AdCampaign.updateOne({ slug }, { $set: setDoc }, { upsert: true });
  const assetCount = existing?.assetPaths?.length || 0;
  const assetNote = assetCount ? `${assetCount} fichier(s), ${existing.assetPaths[0]}${assetCount > 1 ? ', ...' : ''}` : 'aucun — voir import-ad-campaign-asset.js';
  console.log(`✅ AdCampaign slug="${slug}" ${existing ? 'updated' : 'created'} (asset=${assetNote}, targetUrl=${setDoc.targetUrl || '∅'}, label=${setDoc.label || '∅'}, active=${setDoc.active})`);

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message || e);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
