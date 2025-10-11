// scripts/03-event-management/events/import-tariffs.js
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Event } from '../../../src/models/Event.js';
import { Tariff } from '../../../src/models/Tariff.js';
import { TariffPrice } from '../../../src/models/TariffPrice.js';

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

async function readCsv(path, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    // supprime BOM éventuel sur la première ligne
    const L = (lineNo === 1 && line.charCodeAt(0) === 0xFEFF) ? line.slice(1).trim() : line.trim();
    if (!L || L.startsWith('#')) continue;
    const parts = L.split(',').map(s => s.trim());
    // ignore les entêtes "code,label" ou "zoneKey,tariffCode,priceCents"
    const p0 = String(parts[0]||'').toLowerCase();
    if ((p0 === 'code' && String(parts[1]||'').toLowerCase() === 'label')
      || (p0 === 'zonekey' && String(parts[1]||'').toLowerCase() === 'tariffcode')) {
      continue;
    }
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
  const dbn = process.env.MONGODB_DB; // optionnel si DB incluse dans l'URI
  if (!uri) throw new Error('MONGO_URI requis');
  await mongoose.connect(uri, dbn ? { dbName: dbn } : {});

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
  const tariffsCsv = resolveInputFile(argv.tariffs);
  if (!fs.existsSync(tariffsCsv)) throw new Error(`CSV tarifs introuvable: ${argv.tariffs} (cherché aussi dans data/inputs)`);

  await readCsv(tariffsCsv, async (parts, n) => {
    const [code, label] = parts;
    if (!code || String(code).toLowerCase() === 'code') return; // ignore ligne entête résiduelle
    tariffDocs.push({
      code: String(code).trim().toUpperCase(),
      label: (label ?? code)?.toString().trim(),
      priceTableKey: ev.priceTableKey,
      active: true
    });
  });

  // Upsert par code+priceTableKey
  let tUpserts = 0;
  for (const t of tariffDocs) {
    await Tariff.updateOne(
      { priceTableKey: ev.priceTableKey, code: t.code },
      { $set: t },
      { upsert: true }
    );
    tUpserts++;
  }

  // 2) Zone Prices
  console.log('→ Import TariffPrice');
  const priceDocs = [];
  const zonePricesCsv = resolveInputFile(argv.zoneprices);
  if (!fs.existsSync(zonePricesCsv)) throw new Error(`CSV prix zone introuvable: ${argv.zoneprices} (cherché aussi dans data/inputs)`);

  await readCsv(zonePricesCsv, async (parts, n) => {
    const [zoneKey, tariffCode, priceCents] = parts;
    if (!zoneKey || !tariffCode) {
      if (String(zoneKey||'').toLowerCase() === 'zonekey') return; // entête
      throw new Error(`Ligne ${n}: zoneKey/tariffCode manquant`);
    }
    // normalise cents: accepte "800", "800,00", "800.0"
    const centsNorm = String(priceCents ?? '').replace(/\s/g,'').replace(',', '.');
    const cents = Math.round(Number(centsNorm||0));
    priceDocs.push({
      priceTableKey: ev.priceTableKey,
      zoneKey: String(zoneKey).trim().toUpperCase(),
      tariffCode: String(tariffCode).trim().toUpperCase(),
      priceCents: Number.isFinite(cents) ? cents : 0
    });
  });

  // Upsert par priceTableKey + zoneKey + tariffCode
  let pUpserts = 0;
  for (const p of priceDocs) {
    const filter = {
      zoneKey: p.zoneKey,
      tariffCode: p.tariffCode,
      $or: [
        { priceTableKey: ev.priceTableKey },
        {
          priceTableKey: { $in: [null, ''] },
          seasonCode: { $in: [null, ''] },
          venueSlug: { $in: [null, ''] }
        }
      ]
    };

    const update = {
      $set: {
        priceTableKey: ev.priceTableKey,
        zoneKey: p.zoneKey,
        tariffCode: p.tariffCode,
        priceCents: p.priceCents
      }
    };

    await TariffPrice.updateOne(filter, update, { upsert: true, setDefaultsOnInsert: true });
    pUpserts++;
  }

  console.log(`✅ Import terminé · Tariffs upserted: ${tUpserts} · Prices upserted: ${pUpserts}`);
  await mongoose.disconnect();
}

main().catch(async (e)=>{ console.error('❌', e.message); process.exitCode=1; try{await mongoose.disconnect();}catch{} });
