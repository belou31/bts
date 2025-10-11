/**
 * Import base seats from SVG
 *
 * Parses a venue plan SVG and stores seat metadata into the SeatCatalog collection.
 *
 * Usage:
 *   node scripts/01-initialization/venues/import-seats-from-svg.js <venueSlug> <path/to/plan.svg>
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI: Mongo database connection (required)
 *
 * Templates:
 *   - data/templates/env/.env.template
 *   - data/templates/files/plan.svg
 */

import fs from 'fs';
import path from 'path';
import { load } from 'cheerio';
import mongoose from 'mongoose';

import { SeatCatalog } from '../../../src/models/SeatCatalog.js';

import dotenv from 'dotenv';
dotenv.config();

const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');

function resolveInputFile(p) {
  if (!p) return p;
  const absolute = path.resolve(p);
  if (fs.existsSync(absolute)) return absolute;
  const fromInputs = path.resolve(INPUT_DIR, p);
  if (fs.existsSync(fromInputs)) return fromInputs;
  return absolute;
}

(async () => {
  const [venueSlug, svgFile] = process.argv.slice(2);
  if (!venueSlug || !svgFile) {
    console.error('Usage: node scripts/01-initialization/venues/import-seats-from-svg.js <venueSlug> <path/to/plan.svg>');
    process.exit(1);
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(uri);

  const svgPath = resolveInputFile(svgFile);
  if (!fs.existsSync(svgPath)) {
    console.error('Plan introuvable:', svgFile, '(cherché aussi dans data/inputs)');
    process.exit(1);
  }

  const svg = fs.readFileSync(svgPath, 'utf8');
  const $ = load(svg);
  
  const nodes = $('[data-seat-id]');
  console.log(`Found ${nodes.length} seats in SVG`);
  let upserts = 0;

  await Promise.all(nodes.map((i, el) => {
    const seatId = $(el).attr('data-seat-id')?.trim();
    if (!seatId) return;
    const zoneAttr = $(el).attr('data-zone')?.trim();
    const zoneKey = zoneAttr || (seatId.split('-')[0] || 'Z');
    const row = $(el).attr('data-row')?.trim() || '';
    const number = $(el).attr('data-number')?.trim() || '';
    const selector = `[data-seat-id="${seatId.replace(/"/g,'&quot;')}"]`;

    return SeatCatalog.findOneAndUpdate(
      { venueSlug, seatId },
      { $set: { zoneKey, row, number, svgSelector: selector } },
      { upsert: true }
    ).then(()=> upserts++);
  }).get());

  console.log(`Upserted ${upserts} seats into catalog for venue ${venueSlug}`);
  await mongoose.disconnect();
})();
