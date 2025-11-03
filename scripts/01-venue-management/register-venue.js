#!/usr/bin/env node
/**
 * Register a venue (optionally copying an SVG plan)
 *
 * Usage:
 *   node scripts/01-venue-management/register-venue.js <slug> "<Venue Name>" [plan.svg] [--overwrite]
 *
 * Behaviour:
 *   - When a plan file is provided, it is copied to src/public/static/venues/<slug>/plan.svg
 *   - If no plan is provided, the existing plan is kept. On first registration a plan is required.
 */

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Venue } from '../../src/models/Venue.js';

dotenv.config();

const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');
const DEST_ROOT = path.resolve('src/public/static/venues');

function usage() {
  console.error('Usage: node scripts/01-venue-management/register-venue.js <slug> "<Venue Name>" [plan.svg] [--overwrite]');
  process.exit(1);
}

function resolveInputFile(p) {
  if (!p) return p;
  const absolute = path.resolve(p);
  if (fs.existsSync(absolute)) return absolute;
  const candidate = path.resolve(INPUT_DIR, p);
  if (fs.existsSync(candidate)) return candidate;
  return absolute;
}

const rawArgs = process.argv.slice(2);
const options = new Set(rawArgs.filter(a => a.startsWith('--')));
const positional = rawArgs.filter(a => !a.startsWith('--'));

const slug = positional[0];
const name = positional[1];
const planArg = positional[2] || null;
const overwrite = options.has('--overwrite');

if (!slug || !name) usage();

const destDir = path.join(DEST_ROOT, slug);
const destSvg = path.join(destDir, 'plan.svg');
const webSvgPath = `/static/venues/${slug}/plan.svg`;

let planToCopy = null;
if (planArg) {
  planToCopy = resolveInputFile(planArg);
  if (!fs.existsSync(planToCopy)) {
    console.error(`Plan introuvable: ${planArg}`);
    process.exit(1);
  }
  if (path.extname(planToCopy).toLowerCase() !== '.svg') {
    console.error('Le fichier fourni doit être un .svg');
    process.exit(1);
  }
}

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGO_URI (ou MONGODB_URI) manquant dans l\'environnement');
  process.exit(1);
}

await mongoose.connect(uri);
try {
  const existing = await Venue.findOne({ slug }).lean();

  if (!planToCopy && !existing && !fs.existsSync(destSvg)) {
    console.error('Aucun plan existant et aucun fichier fourni : fournissez un SVG lors de la première création.');
    process.exit(1);
  }

  if (planToCopy) {
    fs.mkdirSync(destDir, { recursive: true });
    if (!overwrite && fs.existsSync(destSvg)) {
      console.log(`⚠️  ${destSvg} existe déjà — utilisez --overwrite pour le remplacer`);
    } else {
      fs.copyFileSync(planToCopy, destSvg);
      console.log(`✓ Plan copié → ${destSvg}`);
    }
  } else if (!fs.existsSync(destSvg)) {
    console.log('ℹ️  Aucun plan utilisé, le chemin existant est conservé.');
  }

  const svgPath = planToCopy || !existing ? webSvgPath : (existing.svgPath || webSvgPath);
  const venue = await Venue.findOneAndUpdate(
    { slug },
    { $set: { name, svgPath } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log('✓ Venue enregistrée :', {
    slug: venue.slug,
    name: venue.name,
    svgPath: venue.svgPath
  });
} finally {
  await mongoose.disconnect();
}

process.exit(0);
