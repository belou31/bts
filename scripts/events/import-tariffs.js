// scripts/events/import-tariffs.js
import fs from 'fs';
import readline from 'readline';
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Event } from '../../src/models/Event.js';
import { Tariff } from '../../src/models/Tariff.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';

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
    .option('tariffs', { type:'string', demandOption:true, desc:'CSV: code,label' })
    .option('zoneprices', { type:'string', demandOption:true, desc:'CSV: zoneKey,tariffCode,priceCents' })
    .help().argv;

  const uri = process.env.MONGO_URI;
  const dbn = "bts";
  if (!uri || !dbn) throw new Error('MONGO_URI / MONGODB_DB requis');

  await mongoose.connect(uri, { dbName: dbn });

  // Résout l’event
  const ev = await (async () => {
    if (argv.event.match(/^[0-9a-f]{24}$/i)) return Event.findById(argv.event).lean();
    return Event.findOne({ slug: argv.event }).lean();
  })();
  if (!ev) throw new Error('Event introuvable');
  if (!ev.priceTableKey) throw new Error('priceTableKey manquant sur l’événement');

  // 1) Tarifs
  console.log('→ Import Tariffs vers priceTableKey =', ev.priceTableKey);
  const tariffDocs = [];
  await readCsv(argv.tariffs, async (parts, n) => {
    const [code, label] = parts;
    if (!code) throw new Error(`Ligne ${n}: code manquant`);
    tariffDocs.push({
      code: String(code).toUpperCase(),
      label: label || code,
      priceTableKey: ev.priceTableKey,
      isActive: true
    });
  });

  // Upsert par code+priceTableKey
  for (const t of tariffDocs) {
    await Tariff.updateOne(
      { priceTableKey: ev.priceTableKey, code: t.code },
      { $set: t },
      { upsert: true }
    );
  }

  // 2) Zone Prices
  console.log('→ Import TariffPrice');
  const priceDocs = [];
  await readCsv(argv.zoneprices, async (parts, n) => {
    const [zoneKey, tariffCode, priceCents] = parts;
    if (!zoneKey || !tariffCode) throw new Error(`Ligne ${n}: zoneKey/tariffCode manquant`);
    priceDocs.push({
      priceTableKey: ev.priceTableKey,
      zoneKey: String(zoneKey),
      tariffCode: String(tariffCode).toUpperCase(),
      priceCents: Number(priceCents||0)|0,
      isActive: true
    });
  });

  // Upsert par priceTableKey + zoneKey + tariffCode
  for (const p of priceDocs) {
    await TariffPrice.updateOne(
      { priceTableKey: ev.priceTableKey, zoneKey: p.zoneKey, tariffCode: p.tariffCode },
      { $set: p },
      { upsert: true }
    );
  }

  console.log('✅ Import terminé');
  await mongoose.disconnect();
}

main().catch(async (e)=>{ console.error('❌', e.message); process.exitCode=1; try{await mongoose.disconnect();}catch{} });
