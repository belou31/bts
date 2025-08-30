
import fs from 'fs';
import path from 'path';
import cheerio from 'cheerio';
import mongoose from 'mongoose';

import { SeatCatalog } from '../../src/models/SeatCatalog.js';

import dotenv from 'dotenv';
dotenv.config();

(async () => {
  const [venueSlug, svgFile] = process.argv.slice(2);
  if (!venueSlug || !svgFile) {
    console.error('Usage: node scripts/venues/import-seats-from-svg.js <venueSlug> <path/to/plan.svg>');
    process.exit(1);
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(uri);

  const svg = fs.readFileSync(path.resolve(svgFile), 'utf8');
  const $ = cheerio.load(svg, { xmlMode: true });

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

