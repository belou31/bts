// scripts/reports/import-provisions.js
// Usage :
//   node scripts/reports/import-provisions.js /path/provisions.csv \
//     [--season=2025-2026] [--venue=patinoire-blagnac] \
//     [--clearFirst] [--clearUnavailable] [--onlyIfAvailable] \
//     [--useCsvStatus] [--provisionStatus=busy] [--dryRun]
//
// CSV attendu (export-provisions.js) :
// seatId,zoneKey,rowKey,status,tag
//
// Logique de statut :
// - Si --useCsvStatus ET status CSV non vide => on l'applique tel quel.
// - Sinon, si tag == UNAVAILABLE => status = 'unavailable'.
// - Sinon, status = --provisionStatus (défaut 'busy').
// - On ne modifie jamais les sièges 'booked' (sécurité).
//
// --clearFirst : remet à 'available' tous les sièges provisoires (busy/provisioned/blocked)
//                de la saison/lieu (booked intouché, 'unavailable' conservé sauf --clearUnavailable).
//
// --onlyIfAvailable : n'applique le statut que si le siège est actuellement 'available'.
//
// --dryRun : n'écrit pas en base.

import fs from 'node:fs';
import readline from 'node:readline';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { Seat } from '../../src/models/Seat.js';

const uri = process.env.MONGO_URI;
if (!uri) { console.error('[import-provisions] MONGO_URI manquant'); process.exit(1); }

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node scripts/reports/import-provisions.js /path/provisions.csv [options]');
  process.exit(1);
}

const SEASON = args.find(a => a.startsWith('--season='))?.split('=')[1] || null;
const VENUE  = args.find(a => a.startsWith('--venue='))?.split('=')[1]  || null;

const CLEAR_FIRST       = args.includes('--clearFirst');
const CLEAR_UNAVAILABLE = args.includes('--clearUnavailable');
const ONLY_IF_AVAILABLE = args.includes('--onlyIfAvailable');
const USE_CSV_STATUS    = args.includes('--useCsvStatus');
const DRY_RUN           = args.includes('--dryRun');

const provisionStatusArg = args.find(a => a.startsWith('--provisionStatus='))?.split('=')[1];
const DEFAULT_PROVISION_STATUS = (provisionStatusArg || 'busy').toLowerCase();

// --- petits helpers CSV & seatId ---
function parseCsvLine(line) {
  const out = []; let cur = ''; let i = 0; let inQ = false;
  while (i < line.length) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i+1] === '"') { cur += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cur += ch; i++; continue;
    } else {
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ',') { out.push(cur); cur=''; i++; continue; }
      cur += ch; i++;
    }
  }
  out.push(cur);
  return out;
}
function padSeatNum(seatId) {
  const s = String(seatId || '');
  const parts = s.split('-');
  if (parts.length < 3) return s;
  const last = parts.pop();
  if (/^\d+$/.test(last)) parts.push(last.padStart(3, '0')); else parts.push(last);
  return parts.join('-');
}

// Détermine le status cible à partir des colonnes CSV + options
function resolveTargetStatus(csvStatus, tag) {
  const st = String(csvStatus || '').trim().toLowerCase();
  if (USE_CSV_STATUS && st) return st;
  const t = String(tag || '').trim().toUpperCase();
  if (t === 'UNAVAILABLE') return 'unavailable';
  return DEFAULT_PROVISION_STATUS; // busy | provisioned | blocked …
}

async function clearFirst({ seasonCode, venueSlug }) {
  // On remet à 'available' les sièges provisoires (busy/provisioned/blocked).
  // On ne touche pas aux 'booked'. On garde 'unavailable' sauf --clearUnavailable.
  const q = {};
  if (seasonCode) q.seasonCode = seasonCode;
  if (venueSlug)  q.venueSlug  = venueSlug;

  const OR = [
    { status: 'busy' },
    { status: 'provisioned' },
    { status: 'blocked' }
  ];
  if (CLEAR_UNAVAILABLE) OR.push({ status: 'unavailable' });
  q.$or = OR;

  const update = { $set: { status: 'available' }, $unset: { provisionTag: '' } };

  if (DRY_RUN) {
    const count = await Seat.countDocuments(q);
    console.log(`[import-provisions] [DRY] clearFirst → ${count} siège(s) repasseraient à 'available'${CLEAR_UNAVAILABLE ? ' (incluant unavailable)' : ''}`);
    return;
  }

  const r = await Seat.updateMany(q, update, { runValidators: false });
  const n = r.modifiedCount ?? r.nModified ?? 0;
  console.log(`[import-provisions] clearFirst → ${n} modifié(s)${CLEAR_UNAVAILABLE ? ' (incluant unavailable)' : ''}`);
}

async function run() {
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });
  console.log('[import-provisions] connected');

  if (CLEAR_FIRST) {
    await clearFirst({ seasonCode: SEASON, venueSlug: VENUE });
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  let isHeader = true;
  let header = [];

  let updated = 0, skipped = 0, notFound = 0;

  for await (const raw of rl) {
    const line = raw.trimEnd();
    if (!line) continue;

    const cols = parseCsvLine(line);

    if (isHeader) {
      header = cols.map(c => c.trim());
      // au minimum seatId, et si présent on lit status & tag
      if (!header.includes('seatId')) {
        console.error('[import-provisions] CSV sans colonne seatId');
        process.exit(1);
      }
      isHeader = false;
      continue;
    }

    const row = Object.create(null);
    for (let i=0;i<cols.length;i++) row[header[i] ?? `_${i}`] = cols[i];

    const seatIdRaw = row.seatId || '';
    const seatId = padSeatNum(seatIdRaw);
    const csvStatus = row.status || '';
    const tag = row.tag || '';

    if (!seatId) { skipped++; continue; }

    // Query du siège (sécurisée par saison/lieu si fournis)
    const q = { seatId };
    if (SEASON) q.seasonCode = SEASON;
    if (VENUE)  q.venueSlug  = VENUE;

    const seat = await Seat.findOne(q);
    if (!seat) {
      notFound++;
      console.warn(`[import-provisions] seat not found: ${seatId}${SEASON ? ` season=${SEASON}` : ''}${VENUE ? ` venue=${VENUE}` : ''}`);
      continue;
    }

    // Politique de sécurité : ne jamais “dégrader” un seat déjà vendu
    const cur = String(seat.status || '').toLowerCase();
    if (cur === 'booked') { skipped++; continue; }

    if (ONLY_IF_AVAILABLE && cur !== 'available') {
      skipped++;
      continue;
    }

    const targetStatus = resolveTargetStatus(csvStatus, tag);

    if (DRY_RUN) {
      console.log(`• [DRY] ${seatId}: ${cur} → ${targetStatus}  ${tag ? `(tag=${tag})` : ''}`);
    } else {
      seat.status = targetStatus;
      if (tag) seat.provisionTag = tag;
      else if (seat.provisionTag) seat.provisionTag = seat.provisionTag; // no-op, garde existant
      await seat.save();
    }
    updated++;
  }

  console.log(`[import-provisions] done. updated=${updated}, skipped=${skipped}, notFound=${notFound}${DRY_RUN ? ' (dryRun)' : ''}`);

  await mongoose.disconnect();
}

run().catch(e => {
  console.error('[import-provisions] fatal:', e);
  process.exit(1);
});
