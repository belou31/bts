// scripts/events/import-qr-bank.js
import fs from 'fs';
import readline from 'readline';
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Event } from '../../src/models/Event.js';

import dotenv from 'dotenv';
dotenv.config();

async function readCsv(path, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const L = line.trim();
    if (!L || L.startsWith('#')) continue;
    const parts = L.split(',').map(s => s.trim());
    await onRow(parts, lineNo);
  }
}

async function main(){
  const argv = yargs(hideBin(process.argv))
    .option('event', { type:'string', demandOption:true, desc:'eventId ou slug' })
    .option('csv', { type:'string', demandOption:true, desc:'CSV: qrcode,tariff' })
    .option('append', { type:'boolean', default:true, desc:'Ajouter (true) ou remplacer (false)' })
    .help().argv;

  const uri = process.env.MONGO_URI;
  const dbn = "bts";
  if (!uri || !dbn) throw new Error('MONGO_URI / MONGODB_DB requis');

  await mongoose.connect(uri, { dbName: dbn });

  const ev = await (async () => {
    if (argv.event.match(/^[0-9a-f]{24}$/i)) return Event.findById(argv.event);
    return Event.findOne({ slug: argv.event });
  })();
  if (!ev) throw new Error('Event introuvable');

  if (!ev.qrBank) ev.qrBank = { provider:'bank', buckets:{} };
  if (!ev.qrBank.buckets) ev.qrBank.buckets = {};

  const accum = argv.append ? { ...ev.qrBank.buckets } : {};

  await readCsv(argv.csv, async (parts, n) => {
    const [hex, tariff] = parts;
    if (!hex) throw new Error(`Ligne ${n}: qrcode manquant`);
    const key = String(tariff || 'NORMAL').toUpperCase();
    accum[key] = accum[key] || [];
    accum[key].push(hex);
  });

  ev.qrBank.buckets = accum;
  await ev.save();

  console.log('✅ QR importés pour', ev.slug, Object.fromEntries(Object.entries(accum).map(([k,v])=>[k, v.length])));
  await mongoose.disconnect();
}

main().catch(async (e)=>{ console.error('❌', e.message); process.exitCode=1; try{await mongoose.disconnect();}catch{} });
