// scripts/reports/export-seats.js
// Usage: node scripts/reports/export-seats.js <seasonCode> [--venue=slug] [--out=path.csv]
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { Seat } from '../../src/models/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function arg(name, def=null) {
  const p = process.argv.find(a => a.startsWith(`--${name}=`));
  return p ? p.split('=').slice(1).join('=') : def;
}
function toCsvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",;\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
  return s;
}
function csvLine(arr){ return arr.map(toCsvCell).join(';')+'\n'; }

async function main() {
  const seasonCode = process.argv[2];
  if (!seasonCode) {
    console.error('Usage: node scripts/reports/export-seats.js <seasonCode> [--venue=slug] [--out=path.csv]');
    process.exit(1);
  }
  const venueSlug = arg('venue', null);
  const outPath   = arg('out', `seats_${seasonCode}${venueSlug?`_${venueSlug}`:''}.csv`);

  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bts';
  await mongoose.connect(uri, {});

  const filter = { seasonCode };
  if (venueSlug) filter.venueSlug = venueSlug;

  const cursor = Seat.find(filter, {
    seatId:1, zoneKey:1, status:1, provisionedFor:1,
    holderFirstName:1, holderLastName:1, lastTariffCode:1, venueSlug:1, seasonCode:1
  }).sort({ seatId:1 }).cursor();

  const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
  out.write(csvLine(['seasonCode','venueSlug','seatId','zoneKey','status','provisionedFor','holderFirstName','holderLastName','lastTariffCode']));

  for await (const s of cursor) {
    out.write(csvLine([
      s.seasonCode||'', s.venueSlug||'', s.seatId||'', s.zoneKey||'',
      s.status||'', s.provisionedFor||'', s.holderFirstName||'', s.holderLastName||'', s.lastTariffCode||''
    ]));
  }
  out.end();
  await new Promise(r => out.on('finish', r));
  await mongoose.disconnect();
  console.log(`Export OK: ${outPath}`);
}
main().catch(e => { console.error(e); process.exit(1); });
