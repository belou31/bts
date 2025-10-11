/**
 * Import zones from CSV
 *
 * Upserts zones for a given season/venue using a CSV file.
 *
 * Usage:
 *   node scripts/01-initialization/seed-zones.js --csv=path/to/zones.csv --venue=patinoire-blagnac [--season=2025-2026]
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI: Mongo database connection (required)
 *   - MONGODB_DB: Optional database name override
 *   - SEASON_CODE: Optional default season code
 *   - VENUE_SLUG: Optional default venue slug
 *
 * Templates:
 *   - data/templates/env/.env.template
 *   - data/templates/csv/zones.template.csv
 */
import fs from 'fs';
import readline from 'readline';
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Zone } from '../../src/models/Zone.js';
import { Season } from '../../src/models/Season.js';
import dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');

function resolveInputFile(p) {
  if (!p) return p;
  const absolute = path.resolve(p);
  if (fs.existsSync(absolute)) return absolute;
  const fromInputs = path.resolve(INPUT_DIR, p);
  if (fs.existsSync(fromInputs)) return fromInputs;
  return absolute;
}

async function getSeasonCode() {
  if (process.env.SEASON_CODE) return process.env.SEASON_CODE;
  const s = await Season.findOne({ isActive: true }).lean();
  const code = s?.code || s?.seasonCode;
  if (!code) throw new Error('No active season (isActive=true) and no SEASON env provided');
  return code;
}

async function readCsv(path, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const raw = (lineNo === 1 && line.charCodeAt(0) === 0xFEFF) ? line.slice(1) : line;
    const L = String(raw || '').trim();
    if (!L || L.startsWith('#')) continue;
    const parts = L.split(',').map(s => s.trim());
    const h0 = String(parts[0]||'').toLowerCase();
    if (h0 === 'key') continue; // ignore header
    await onRow(parts, lineNo);
  }
}

(async () => {
  try {
    const argv = yargs(hideBin(process.argv))
      .option('csv',    { type:'string', demandOption:true, desc:'CSV: key,name,type,access,capacity,quota,svgSelector,isActive' })
      .option('season', { type:'string', desc:'override seasonCode (else from DB/env)' })
      .option('venue',  { type:'string', desc:'override venueSlug (else from env VENUE_SLUG)' })
      .help().argv;

    const opts = {};
    if (process.env.MONGODB_DB) opts.dbName = process.env.MONGODB_DB;
    if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
    await mongoose.connect(uri, opts);

    const seasonCode = argv.season || await getSeasonCode();
    const venueSlug  = argv.venue  || process.env.VENUE_SLUG;
    if (!venueSlug) throw new Error('VENUE_SLUG manquant (env ou --venue)');

    let upserts = 0;
    const csvResolved = resolveInputFile(argv.csv);
    if (!fs.existsSync(csvResolved)) {
      throw new Error(`CSV introuvable: ${argv.csv} (cherché dans ${csvResolved} et data/inputs)`);
    }

    await readCsv(csvResolved, async (parts, n) => {
      const [keyRaw, nameRaw, typeRaw, accessRaw, capRaw, quotaRaw, selRaw, activeRaw] = parts;
      const key   = String(keyRaw||'').trim().toUpperCase();
      if (!key) throw new Error(`L${n}: key manquant`);
      const name  = (nameRaw ? String(nameRaw).trim() : '') || key;
      const type  = (typeRaw ? String(typeRaw).trim().toLowerCase() : 'seated');
      const access= (accessRaw ? String(accessRaw).trim().toUpperCase() : 'PUBLIC');
      const capacity = Number(String(capRaw||'').replace(/\s/g,'')) || 0;
      const quota    = Number(String(quotaRaw||'').replace(/\s/g,'')) || 0;
      const svgSelector = selRaw ? String(selRaw).trim() : undefined;
      const isActive    = (String(activeRaw||'').toLowerCase() === 'false') ? false : true;

      const doc = {
        key, name, type, access, capacity, quota, svgSelector,
        seasonCode, venueSlug, isActive
      };
      await Zone.updateOne(
        { seasonCode, venueSlug, key },
       { $set: doc },
        { upsert: true }
      );
      upserts++;
      console.log(`✓ Upserted zone ${key} (${seasonCode}/${venueSlug})`);
    });

    console.log(`✅ Zones upserted: ${upserts}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('[seed-zones] error:', err);
    process.exit(1);
  }
})();
