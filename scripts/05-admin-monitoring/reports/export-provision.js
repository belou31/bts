// scripts/reports/export-provisions.js
// Usage :
//   node scripts/reports/export-provisions.js [--season=2025-2026] [--venue=patinoire-blagnac] [--onlyProvisioned] [--inferRules] [--unavailableFile=/path/list.txt]
//
// Sortie CSV vers stdout :
// seatId,zoneKey,rowKey,status,tag
//
// • "tag" est pris au choix : seat.provisionTag || (seat.tags contient une valeur plausible) || (si --inferRules : heuristiques ci-dessous)
// • --onlyProvisioned : filtre aux sièges status != 'available' (par défaut off)
// • --inferRules : applique des règles déductives si aucun tag trouvé :
//     VIP        : zone S4
//     SPECIALE  : S3 ou S4A
//     VISITORS  : zone S2 rang F ou G
//     FANCLUB   : zones N5,N6,N7 rang L/M/N
//     UNAVAILABLE : si dans liste fournie (voir --unavailableFile) ou jeu par défaut
//
// NB : si vos tags sont déjà stockés dans la BD (ex: provisionTag), vous n'avez pas besoin de --inferRules.

import fs from 'node:fs';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { Seat } from '../../../src/models/Seat.js';

const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI manquant'); process.exit(1); }

const season = process.argv.find(a => a.startsWith('--season='))?.split('=')[1] || null;
const venue  = process.argv.find(a => a.startsWith('--venue='))?.split('=')[1]  || null;
const onlyProvisioned = process.argv.includes('--onlyProvisioned');
const inferRules = process.argv.includes('--inferRules');
const unavailableFile = process.argv.find(a => a.startsWith('--unavailableFile='))?.split('=')[1] || null;

const csvEscape = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
};

// Normalisation SeatId → S*-*-NNN (3 chiffres)
function padSeatNum(seatId) {
  const s = String(seatId || '');
  const parts = s.split('-');
  if (parts.length < 3) return s;
  const last = parts.pop();
  if (/^\d+$/.test(last)) {
    parts.push(last.padStart(3, '0'));
    return parts.join('-');
  }
  return s;
}
function parseSeatId(seatId) {
  const s = padSeatNum(seatId);
  const parts = s.split('-');
  return {
    zoneKey: parts[0] || '',
    rowKey:  parts[1] || '',
    number:  parts[2] || ''
  };
}

// Liste UNAVAILABLE par défaut (convertie/paddée)
const DEFAULT_UNAVAILABLE = new Set([
  'S2-F-013',
  'S5-E-042','S5-E-043','S5-E-044','S5-E-045',
  'S5-F-048','S5-F-049','S5-F-050',
  'S6-E-046','S6-E-047','S6-F-051','S6-F-052','S6-F-053'
].map(padSeatNum));

function loadUnavailableList(path) {
  if (!path) return new Set();
  try {
    const txt = fs.readFileSync(path, 'utf8');
    const ids = txt.split(/\r?\n/).map(v => padSeatNum(v.trim())).filter(Boolean);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function inferTag(seat) {
  const { zoneKey, rowKey } = parseSeatId(seat.seatId || '');
  // VIP
  if (zoneKey === 'S4') return 'VIP';
  // SPECIALE
  if (zoneKey === 'S3' || zoneKey === 'S4A') return 'SPECIALE';
  // VISITORS
  if (zoneKey === 'S2' && (rowKey === 'F' || rowKey === 'G')) return 'VISITORS';
  // FANCLUB
  if (['N5','N6','N7'].includes(zoneKey) && ['L','M','N'].includes(rowKey)) return 'FANCLUB';
  return '';
}

(async () => {
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });

  const q = {};
  if (season) q.seasonCode = season;
  if (venue)  q.venueSlug  = venue;
  if (onlyProvisioned) q.status = { $ne: 'available' };

  const unavailableSet = loadUnavailableList(unavailableFile);
  // merge défaut
  for (const x of DEFAULT_UNAVAILABLE) unavailableSet.add(x);

  const cursor = Seat.find(q, { _id:0, seatId:1, status:1, zoneKey:1, tags:1, provisionTag:1 }).lean().cursor();

  process.stdout.write(['seatId','zoneKey','rowKey','status','tag'].join(',') + '\n');

  for await (const s of cursor) {
    const { zoneKey, rowKey } = parseSeatId(s.seatId || '');
    let tag =
      (typeof s.provisionTag === 'string' && s.provisionTag) ||
      (Array.isArray(s.tags) ? (s.tags.find(t => typeof t === 'string' && t) || '') : '');

    if (!tag && inferRules) {
      // Heuristique
      tag = inferTag(s);
      // UNAVAILABLE (liste)
      if (!tag && unavailableSet.has(padSeatNum(s.seatId || ''))) tag = 'UNAVAILABLE';
    }

    const row = [
      s.seatId || '',
      zoneKey || (s.zoneKey || ''),
      rowKey,
      s.status || '',
      tag || ''
    ].map(csvEscape).join(',');
    process.stdout.write(row + '\n');
  }

  await mongoose.disconnect();
})();
