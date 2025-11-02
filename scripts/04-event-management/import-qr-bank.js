// scripts/04-event-management/import-qr-bank.js
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Event } from '../../src/models/Event.js';

import dotenv from 'dotenv';
dotenv.config();

const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');
const DEFAULT_BANK = { provider: 'bank', codes: [] };

function resolveInputFile(p) {
  if (!p) return p;
  const absolute = path.resolve(p);
  if (fs.existsSync(absolute)) return absolute;
  const fromInputs = path.resolve(INPUT_DIR, p);
  if (fs.existsSync(fromInputs)) return fromInputs;
  return absolute;
}

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
    .option('csv', { type:'string', demandOption:true, desc:'CSV: qrcode[,ignored]' })
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

  if (!ev.qrBank) ev.qrBank = { ...DEFAULT_BANK };
  if (!Array.isArray(ev.qrBank.codes)) ev.qrBank.codes = [];

  let accum = [];
  if (argv.append) {
    if (Array.isArray(ev.qrBank.codes) && ev.qrBank.codes.length > 0) {
      accum = [...ev.qrBank.codes];
    } else if (ev.qrBank.buckets && typeof ev.qrBank.buckets === 'object') {
      for (const value of Object.values(ev.qrBank.buckets)) {
        if (Array.isArray(value)) {
          for (const hex of value) {
            if (hex) accum.push(String(hex).trim());
          }
        }
      }
    }
  }

  const csvPath = resolveInputFile(argv.csv);
  if (!fs.existsSync(csvPath)) throw new Error(`CSV introuvable: ${argv.csv} (cherché aussi dans data/inputs)`);

  let added = 0;
  await readCsv(csvPath, async (parts, n) => {
    const [hex] = parts;
    const value = String(hex || '').trim();
    if (!value) throw new Error(`Ligne ${n}: qrcode manquant`);
    accum.push(value);
    added++;
  });

  const provider = ev.qrBank?.provider || 'bank';
  ev.qrBank.provider = provider;
  ev.qrBank.codes = accum;
  if ('buckets' in ev.qrBank) {
    delete ev.qrBank.buckets;
  }
  await ev.save();

  console.log('✅ QR importés pour', ev.slug, { total: accum.length, added });
  await mongoose.disconnect();
}

main().catch(async (e)=>{ console.error('❌', e.message); process.exitCode=1; try{await mongoose.disconnect();}catch{} });
