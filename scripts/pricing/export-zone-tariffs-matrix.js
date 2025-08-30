#!/usr/bin/env node
// scripts/pricing/export-zone-tariffs-matrix.js
//
// Usage:
//   node scripts/pricing/export-zone-tariffs-matrix.js <seasonCode> <venueSlug> <outCsvPath>
//
// Sortie CSV :
//   tariffCode,<zoneKey1>,<zoneKey2>,...
//   NORMAL,180,170,160
//   ETUD,126,119,110
//
// Les prix sont exportés en euros (nombre sans décimales si plein, sinon 2 décimales).

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

import { TariffPrice } from '../../src/models/TariffPrice.js';

import dotenv from 'dotenv';
dotenv.config();


function die(msg){ console.error(msg); process.exit(1); }

(async () => {
  const [,, seasonCode, venueSlug, outPath] = process.argv;
  if (!seasonCode || !venueSlug || !outPath) {
    die('Usage: node scripts/pricing/export-zone-tariffs-matrix.js <seasonCode> <venueSlug> <outCsvPath>');
  }
  const uri = process.env.MONGO_URI;
  if (!uri) die('Missing MONGO_URI');
  await mongoose.connect(uri);

  // Récupère toutes les lignes de prix
  const docs = await TariffPrice.find({ seasonCode, venueSlug }).lean();
  if (!docs.length) {
    console.warn('Aucun prix trouvé pour', seasonCode, venueSlug);
  }

  // Liste des zones & des codes tarifs
  const zoneSet = new Set();
  const tariffSet = new Set();
  for (const d of docs) {
    if (d.zoneKey) zoneSet.add(d.zoneKey);
    if (d.tariffCode) tariffSet.add(d.tariffCode);
  }
  const zones = Array.from(zoneSet).sort();
  const tariffs = Array.from(tariffSet).sort();

  // pivot : tariffCode -> { zoneKey: priceCents }
  const pivot = new Map();
  for (const d of docs) {
    const t = d.tariffCode;
    const z = d.zoneKey;
    if (!t || !z) continue;
    const row = pivot.get(t) || {};
    row[z] = d.priceCents;
    pivot.set(t, row);
  }

  // helper euros
  function centsToEuroString(c) {
    if (!Number.isFinite(c)) return '';
    const euros = c / 100;
    // évite 180.00 → "180" ; sinon 126.5 → "126.50"
    return Number.isInteger(euros) ? String(euros) : euros.toFixed(2);
  }

  const header = ['tariffCode', ...zones];
  const lines = [header.join(',')];

  for (const tCode of tariffs) {
    const rowObj = pivot.get(tCode) || {};
    const cells = [tCode];
    for (const z of zones) {
      cells.push(centsToEuroString(rowObj[z]));
    }
    lines.push(cells.join(','));
  }

  const out = path.resolve(outPath);
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(`Exporté en ${out} (tariffs=${tariffs.length}, zones=${zones.length})`);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('ERROR', e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
