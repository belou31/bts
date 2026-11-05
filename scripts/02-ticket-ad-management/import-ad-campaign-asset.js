#!/usr/bin/env node
/**
 * Stages a sponsor asset into data/assets/ads/ under a manually-chosen id,
 * and optionally attaches it to an AdCampaign. A single image file (svg,
 * png, jpg) stages as one asset; a .zip stages a FAMILY of assets (a
 * "carousel") — every image inside becomes one entry in AdCampaign.assetPaths,
 * and buildTicketsPdfBuffer (src/services/tickets-pdf.js) rotates through
 * them by each ticket's position within its order.
 *
 * Usage:
 *   node scripts/02-ticket-ad-management/import-ad-campaign-asset.js --file=<path> --slug=<asset-id>
 *     [--campaign=<campaign-slug>] [--kind=svg|raster] [--dry-run]
 *
 * --slug is the asset's OWN identity (manual, not derived from the source
 * filename) — a single file stages as data/assets/ads/<slug>.<ext>, a zip
 * extracts into data/assets/ads/<slug>/. This is deliberately independent
 * from --campaign: you can stage several asset versions/families
 * (banner-v1, banner-v2, ...) and pick which one a campaign uses.
 *
 * --campaign is optional:
 *   - given: upserts the AdCampaign for that slug with this asset (creating
 *     it if it doesn't exist yet; existing label/targetUrl/active are left
 *     untouched — see set-ad-campaign.js for those).
 *   - omitted: the asset is staged only ("global"/unattached) — attach it
 *     later by re-running with --campaign=<slug> and the same --slug;
 *     --file is then optional (reuses what's already staged).
 */
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();
import AdmZip from 'adm-zip';

import { copyTemplateFile } from '../lib/template-write.js';
import { AdCampaign } from '../../src/models/AdCampaign.js';

const ADS_DIR = path.resolve(process.cwd(), 'data', 'assets', 'ads');
const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');
const IMAGE_EXT_KIND = { '.svg': 'svg', '.png': 'raster', '.jpg': 'raster', '.jpeg': 'raster' };

const argv = yargs(hideBin(process.argv))
  .option('file', { type: 'string', desc: 'Fichier source: .svg/.png/.jpg (un asset) ou .zip (famille/carrousel) — omis = réutilise ce qui est déjà en place pour ce slug' })
  .option('slug', { type: 'string', demandOption: true, desc: 'Identité de l\'asset (manuelle, ex: sponsor-x-banner-v2)' })
  .option('campaign', { type: 'string', desc: 'Slug de campagne à attacher (vide = asset mis en place seul, non attaché)' })
  .option('kind', { type: 'string', choices: ['svg', 'raster'], desc: 'Type d\'asset pour un fichier unique (déduit de l\'extension si omis, ignoré pour un zip)' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Aperçu sans écriture' })
  .help()
  .argv;

function resolveInputFile(p) {
  const absolute = path.resolve(p);
  if (fs.existsSync(absolute)) return absolute;
  const fromInputs = path.resolve(INPUT_DIR, p);
  if (fs.existsSync(fromInputs)) return fromInputs;
  return absolute;
}

// Recursively collects image files under dir, returning paths relative to
// dir (POSIX-separated), sorted — the sort order IS the carousel order.
function listImageFilesRecursive(dir, base = dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(listImageFilesRecursive(full, base));
    } else if (IMAGE_EXT_KIND[path.extname(entry.name).toLowerCase()]) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

function uniformKindOf(files) {
  const kinds = new Set(files.map(f => IMAGE_EXT_KIND[path.extname(f).toLowerCase()]));
  if (kinds.size > 1) throw new Error(`Fichiers de types mixtes (svg + raster) — pas supporté, uniformisez le zip.`);
  return [...kinds][0];
}

function findExistingStaged(slug) {
  const familyDir = path.join(ADS_DIR, slug);
  if (fs.existsSync(familyDir) && fs.statSync(familyDir).isDirectory()) {
    const files = listImageFilesRecursive(familyDir);
    if (files.length) return { assetKind: uniformKindOf(files), assetPaths: files.map(f => `ads/${slug}/${f}`) };
  }
  if (fs.existsSync(ADS_DIR)) {
    const match = fs.readdirSync(ADS_DIR).find(f =>
      path.basename(f, path.extname(f)) === slug && IMAGE_EXT_KIND[path.extname(f).toLowerCase()]
    );
    if (match) return { assetKind: IMAGE_EXT_KIND[path.extname(match).toLowerCase()], assetPaths: [`ads/${match}`] };
  }
  return null;
}

async function main() {
  const slug = String(argv.slug).trim().toLowerCase();
  if (!slug) throw new Error('--slug manquant');
  const campaignSlug = argv.campaign ? String(argv.campaign).trim().toLowerCase() : null;

  let assetKind;
  let assetPaths;

  if (argv.file) {
    const sourcePath = resolveInputFile(argv.file);
    if (!fs.existsSync(sourcePath)) throw new Error(`Fichier introuvable: ${argv.file} (cherché aussi dans data/inputs)`);
    const ext = path.extname(sourcePath).toLowerCase();

    if (ext === '.zip') {
      const zip = new AdmZip(sourcePath);
      const previewFiles = zip.getEntries()
        .filter(e => !e.isDirectory && !e.entryName.split('/').some(p => p.startsWith('.') || p === '__MACOSX'))
        .map(e => e.entryName)
        .filter(name => IMAGE_EXT_KIND[path.extname(name).toLowerCase()])
        .sort();
      if (!previewFiles.length) throw new Error('Aucun fichier image (svg/png/jpg) trouvé dans le zip.');
      uniformKindOf(previewFiles); // validates before writing anything

      if (argv['dry-run']) {
        console.log(`🧪 Dry-run — would extract ${previewFiles.length} asset(s) into data/assets/ads/${slug}/: ${previewFiles.join(', ')}`);
        return;
      }

      const targetDir = path.join(ADS_DIR, slug);
      fs.mkdirSync(targetDir, { recursive: true });
      zip.extractAllTo(targetDir, true);
      const files = listImageFilesRecursive(targetDir);
      assetKind = uniformKindOf(files);
      assetPaths = files.map(f => `ads/${slug}/${f}`);
      console.log(`✓ ${files.length} asset(s) extrait(s) dans data/assets/ads/${slug}/: ${files.join(', ')}`);
    } else {
      assetKind = argv.kind || IMAGE_EXT_KIND[ext] || 'raster';
      const targetFileName = `${slug}${ext}`;
      const targetPath = path.join(ADS_DIR, targetFileName);
      const assetPathRel = `ads/${targetFileName}`;

      const { existed, changed, write } = copyTemplateFile({ sourcePath, targetPath });
      console.log(existed
        ? (changed ? `  ~ data/assets/${assetPathRel} will be overwritten (content differs)` : `  (no change — content identical to existing data/assets/${assetPathRel})`)
        : `  (new file: data/assets/${assetPathRel})`);

      if (argv['dry-run']) {
        console.log(`🧪 Dry-run — would stage data/assets/${assetPathRel}${campaignSlug ? ` and attach to campaign "${campaignSlug}"` : ' (unattached)'}.`);
        return;
      }
      if (changed) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        write();
        console.log(`✓ Asset written to data/assets/${assetPathRel}`);
      }
      assetPaths = [assetPathRel];
    }
  } else {
    const existing = findExistingStaged(slug);
    if (!existing) throw new Error(`--file absent et aucun asset déjà en place pour le slug "${slug}" (data/assets/ads/${slug}.* ou data/assets/ads/${slug}/)`);
    assetKind = existing.assetKind;
    assetPaths = existing.assetPaths;
    console.log(`ℹ Réutilisation de ${assetPaths.length} asset(s) déjà en place pour "${slug}": ${assetPaths.join(', ')}`);
    if (argv['dry-run']) {
      console.log(campaignSlug ? `🧪 Dry-run — would attach to campaign "${campaignSlug}".` : '🧪 Dry-run — nothing to attach (no --campaign).');
      return;
    }
  }

  if (!campaignSlug) {
    console.log(`✅ Asset "${slug}" en place (${assetPaths.length} fichier(s), data/assets/${assetPaths[0]}${assetPaths.length > 1 ? ', ...' : ''}) — non attaché à une campagne. Utilisez --campaign=<slug> pour l'attacher (--file n'est alors plus nécessaire).`);
    return;
  }

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI/MONGODB_URI manquant');
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  const res = await AdCampaign.updateOne(
    { slug: campaignSlug },
    {
      $set: { assetKind, assetPaths },
      $setOnInsert: { label: null, targetUrl: null, active: true }
    },
    { upsert: true }
  );
  const action = (res.upsertedCount ?? 0) > 0 ? 'created' : ((res.modifiedCount ?? 0) > 0 ? 'updated' : 'unchanged');
  console.log(`✅ AdCampaign slug="${campaignSlug}" ${action} (${assetPaths.length} asset(s))`);

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message || e);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
