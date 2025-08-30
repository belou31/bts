#!/usr/bin/env node
// scripts/pricing/import-zone-tariffs.js
//
// Usage (format LISTE *ou* MATRICE; auto-détection ou --format):
//   node scripts/pricing/import-zone-tariffs.js <seasonCode> <venueSlug> <csvPath> [--format=list|matrix] [--delimiter=,|;]
//
// Formats supportés:
//
// LISTE (legacy) : zoneKey,tariffCode,priceCents | priceEuro/prix/prix_euro
//   zoneKey,tariffCode,priceEuro
//   S1,NORMAL,180
//   S1,ETUD,"126,00"
//   N1,NORMAL,170
//
// MATRICE (nouveau) : 1ère col = tariffCode (ou code/tariff), colonnes suivantes = zoneKey
//   tariffCode,S1,N1,N2
//   NORMAL,180,170,160
//   ETUD,126,119,110
//
// Notes :
//  - Détecte automatiquement , ou ; comme séparateur (override possible via --delimiter).
//  - Gère BOM UTF-8 éventuel.
//  - Cellules prix : "180", "180.00", "180,00" → OK (euros) ; "18000" → centimes directs.

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import mongoose from 'mongoose';

import { TariffPrice } from '../../src/models/TariffPrice.js';

import dotenv from 'dotenv';
dotenv.config();

function die(msg) { console.error(msg); process.exit(1); }

const argv = process.argv.slice(2);
const seasonCode = argv[0];
const venueSlug = argv[1];
const csvPath = argv[2];

const explicitFormat = (argv.find(a => a.startsWith('--format=')) || '').split('=')[1] || null;
const explicitDelim  = (argv.find(a => a.startsWith('--delimiter=')) || '').split('=')[1] || null;

if (!seasonCode || !venueSlug || !csvPath) {
  die('Usage: node scripts/pricing/import-zone-tariffs.js <seasonCode> <venueSlug> <csvPath> [--format=list|matrix] [--delimiter=,|;]');
}

function stripBOM(s) {
  if (!s) return s;
  return s.replace(/^\uFEFF/, '');
}

// --- delimiter detect: compte , et ; hors guillemets
function detectDelimiter(line) {
  if (explicitDelim === ',' || explicitDelim === ';') return explicitDelim;
  let comma = 0, semi = 0, inQ = false;
  for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ) {
      if (ch === ',') comma++;
      else if (ch === ';') semi++;
    }
  }
  return semi > comma ? ';' : ','; // défaut: ','
}

function parseCSVLine(line, delim) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseEuroToCents(s) {
  if (s == null || s === '') return null;
  const cleaned = String(s).trim().replace(/\s/g, '').replace(',', '.');
  const n = Number(cleaned);
  if (Number.isFinite(n)) return Math.round(n * 100);
  return null;
}

function parsePriceCell(val) {
  if (val == null) return null;
  const sv = String(val).trim();
  if (sv === '') return null;
  if (/^\d+$/.test(sv) && Number(sv) > 999) return Number(sv); // déjà des centimes
  const cents = parseEuroToCents(sv); // euros -> centimes
  return Number.isFinite(cents) ? cents : null;
}

function headersLC(arr) {
  return arr.map(h => stripBOM(h).trim().toLowerCase());
}

function detectFormat(hdrLC) {
  if (explicitFormat === 'list' || explicitFormat === 'matrix') return explicitFormat;

  // LISTE si présence d’indices caractéristiques
  const hasListSig =
    hdrLC.includes('zonekey') ||
    hdrLC.includes('zone') ||
    hdrLC.includes('pricecents') ||
    hdrLC.includes('priceeuro') ||
    hdrLC.includes('prix') ||
    hdrLC.includes('prix_euro');

  if (hasListSig) return 'list';

  // MATRICE si 1ère col = tariffCode/code/tariff
  const first = hdrLC[0] || '';
  if (['tariffcode','code','tariff'].includes(first)) return 'matrix';

  // fallback : si on voit des colonnes type S1/N1/… sans zoneKey ni prix*
  const hasTariffFirst = ['tariffcode','code','tariff'].some(k => hdrLC.includes(k));
  if (hasTariffFirst) return 'matrix';

  return null;
}

(async () => {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) die('Missing MONGO_URI in .env');
  await mongoose.connect(mongoUri);

  const full = path.resolve(csvPath);
  if (!fs.existsSync(full)) die(`CSV not found: ${full}`);

  const fileFirstLine = fs.readFileSync(full, 'utf8').split(/\r?\n/).find(l => l.trim().length);
  if (!fileFirstLine) die('CSV appears empty');
  const delimiter = detectDelimiter(fileFirstLine);
  console.log(`[import-zone-tariffs] delimiter="${delimiter}"`);

  const rl = readline.createInterface({
    input: fs.createReadStream(full, 'utf8'),
    crlfDelay: Infinity
  });

  let header = null;
  let headerLC = null;
  let mode = null;
  let rowCount = 0;
  let upserts = 0;
  let skips = 0;

  for await (const raw0 of rl) {
    const raw = raw0.replace(/\r$/, '');
    if (!raw.trim()) continue;

    if (!header) {
      header = parseCSVLine(raw, delimiter).map(stripBOM);
      headerLC = headersLC(header);
      mode = detectFormat(headerLC);
      if (!mode) {
        die(`Impossible de détecter le format CSV.\nEn-têtes vues: ${header.join(' | ')}\nAttendu:\n- LISTE: zoneKey,tariffCode,priceCents|priceEuro\n- MATRICE: tariffCode[,label?], <zoneKey...>\n(ou forcez via --format=list|matrix)`);
      }
      console.log(`[import-zone-tariffs] Format détecté: ${mode.toUpperCase()}`);
      continue;
    }

    const cells = parseCSVLine(raw, delimiter);
    rowCount += 1;

    if (mode === 'list') {
      const row = Object.fromEntries(headerLC.map((h,i) => [h, cells[i] ?? '']));

      const zoneKey = row.zonekey || row.zone || row['zone_key'];
      const tariffCode = (row.tariffcode || row.tariff || row.code || '').toUpperCase();

      let priceCents = Number(row.pricecents);
      if (!Number.isFinite(priceCents) || priceCents <= 0) {
        priceCents = parsePriceCell(row.priceeuro || row.prix || row['prix_euro']);
      }

      if (!zoneKey || !tariffCode || !Number.isFinite(priceCents)) {
        console.warn('SKIP invalid row (LIST):', row);
        skips++;
        continue;
      }

      await TariffPrice.findOneAndUpdate(
        { seasonCode, venueSlug, zoneKey, tariffCode },
        { $set: { priceCents } },
        { upsert: true, new: true }
      );
      upserts++;

    } else {
      // MATRIX
      const idxCode = headerLC.findIndex(h => ['tariffcode','code','tariff'].includes(h));
      if (idxCode < 0) die('En-tête matrice invalide: première colonne doit être tariffCode|code|tariff');

      const rawCode = cells[idxCode] || '';
      const tariffCode = String(rawCode).trim().toUpperCase();
      if (!tariffCode) { console.warn('SKIP empty tariffCode:', cells); skips++; continue; }

      const known = new Set(['tariffcode','code','tariff','label']);
      const zoneCols = header.map((name, i) => ({ name: stripBOM(name), i, lc: headerLC[i] }))
                             .filter(c => !known.has(c.lc));

      let wrote = 0;
      for (const col of zoneCols) {
        const zoneKey = (col.name || '').trim();
        if (!zoneKey) continue;

        const val = cells[col.i];
        const priceCents = parsePriceCell(val);
        if (!Number.isFinite(priceCents) || priceCents <= 0) continue;

        await TariffPrice.findOneAndUpdate(
          { seasonCode, venueSlug, zoneKey, tariffCode },
          { $set: { priceCents } },
          { upsert: true, new: true }
        );
        upserts++;
        wrote++;
      }

      if (wrote === 0) {
        console.warn(`SKIP tariffCode=${tariffCode} (aucun prix exploitable sur cette ligne)`);
        skips++;
      }
    }
  }

  console.log(`[import-zone-tariffs] Terminé. lignes=${rowCount} upserts=${upserts} skips=${skips} (season=${seasonCode}, venue=${venueSlug})`);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('ERROR', e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
