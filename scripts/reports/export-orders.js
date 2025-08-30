// scripts/reports/export-orders.js
// Usage: node scripts/reports/export-orders.js <seasonCode> [--venue=slug] [--out=path.csv]
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { Order } from '../../src/models/index.js';

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
    console.error('Usage: node scripts/reports/export-orders.js <seasonCode> [--venue=slug] [--out=path.csv]');
    process.exit(1);
  }
  const venueSlug = arg('venue', null);
  const outPath   = arg('out', `orders_${seasonCode}${venueSlug?`_${venueSlug}`:''}.csv`);

  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bts';
  await mongoose.connect(uri, {});

  const filter = { seasonCode };
  if (venueSlug) filter.venueSlug = venueSlug;

  const cursor = Order.find(filter).cursor();
  const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
  out.write(csvLine(['orderId','createdAt','status','payerEmail','seatId','tariffCode','priceCents','totalCents','seasonCode','venueSlug']));

  for await (const o of cursor) {
    const base = [String(o._id), o.createdAt?.toISOString() || '', o.status || '', o.payerEmail || '', '', '', '', o.totalCents||0, o.seasonCode||'', o.venueSlug||''];
    if (Array.isArray(o.lines) && o.lines.length) {
      for (const l of o.lines) {
        const row = [...base];
        row[4] = l.seatId || '';
        row[5] = l.tariffCode || '';
        row[6] = l.priceCents || 0;
        out.write(csvLine(row));
      }
    } else {
      out.write(csvLine(base));
    }
  }
  out.end();
  await new Promise(r => out.on('finish', r));
  await mongoose.disconnect();
  console.log(`Export OK: ${outPath}`);
}
main().catch(e => { console.error(e); process.exit(1); });
