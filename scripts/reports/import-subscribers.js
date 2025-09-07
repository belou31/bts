// scripts/reports/import-subscribers.js
// Usage :
//   node scripts/reports/import-subscribers.js /path/subscribers.csv [--match=email|email+season|email+season+venue] [--updateOnly] [--dryRun]
//
// - --match=…             clé de réconciliation (défaut: email+season+venue)
// - --updateOnly          n'insère pas de nouveaux abonnés (update seulement si trouvé)
// - --dryRun              pas d'écriture, affiche le plan
//
// CSV attendu (depuis export-subscribers.js) :
// email,firstName,lastName,seasonCode,venueSlug,prefSeatId,previousSeasonSeats,isActive,notes
//
// previousSeasonSeats : séparé par ";"

import fs from 'node:fs';
import readline from 'node:readline';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { Subscriber } from '../../src/models/Subscriber.js';

const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI manquant'); process.exit(1); }

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node scripts/reports/import-subscribers.js /path/subscribers.csv [--match=...] [--updateOnly] [--dryRun]');
  process.exit(1);
}
const MATCH = (args.find(a => a.startsWith('--match='))?.split('=')[1] || 'email+season+venue').toLowerCase();
const UPDATE_ONLY = args.includes('--updateOnly');
const DRY_RUN = args.includes('--dryRun');

function parseCsvLine(line) {
  const out = [];
  let cur = '', i = 0, inQ = false;
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

function splitPrevSeats(s) {
  const x = String(s || '').trim();
  if (!x) return [];
  // accepte ; , ou | comme séparateurs
  return x.split(/[;,|]/).map(v => v.trim()).filter(Boolean);
}

function toBool01(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'y') return true;
  if (s === '0' || s === 'false' || s === 'no'  || s === 'n') return false;
  return undefined;
}

function keyFor(sub) {
  const email = (sub.email || '').toLowerCase();
  const season = sub.seasonCode || '';
  const venue  = sub.venueSlug  || '';
  if (MATCH === 'email') return `e:${email}`;
  if (MATCH === 'email+season') return `e:${email}|s:${season}`;
  return `e:${email}|s:${season}|v:${venue}`; // email+season+venue
}

async function run() {
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  let header = [];
  let isHeader = true;

  let created = 0, updated = 0, skipped = 0;

  for await (const raw of rl) {
    const line = raw.trimEnd();
    if (!line) continue;
    const cols = parseCsvLine(line);

    if (isHeader) {
      header = cols.map(c => c.trim());
      const need = ['email','firstName','lastName','seasonCode','venueSlug','prefSeatId','previousSeasonSeats','isActive','notes'];
      const ok = need.every(k => header.includes(k));
      if (!ok) { console.error('[import-subscribers] Header inattendu:', header.join(',')); process.exit(1); }
      isHeader = false;
      continue;
    }

    const row = Object.create(null);
    for (let i=0;i<cols.length;i++) row[header[i] ?? `_${i}`] = cols[i];

    const sub = {
      email:      String(row.email || '').trim(),
      firstName:  String(row.firstName || ''),
      lastName:   String(row.lastName  || ''),
      seasonCode: String(row.seasonCode || ''),
      venueSlug:  String(row.venueSlug  || ''),
      prefSeatId: String(row.prefSeatId || ''),
      previousSeasonSeats: splitPrevSeats(row.previousSeasonSeats),
      notes: String(row.notes || '')
    };
    const isAct = toBool01(row.isActive);
    if (typeof isAct === 'boolean') sub.isActive = isAct;

    if (!sub.email) { skipped++; continue; } // email obligatoire clé

    const q = (() => {
      if (MATCH === 'email') return { email: new RegExp(`^${sub.email}$`, 'i') };
      if (MATCH === 'email+season') return { email: new RegExp(`^${sub.email}$`, 'i'), seasonCode: sub.seasonCode };
      return { email: new RegExp(`^${sub.email}$`, 'i'), seasonCode: sub.seasonCode, venueSlug: sub.venueSlug };
    })();

    const existing = await Subscriber.findOne(q);
    if (!existing) {
      if (UPDATE_ONLY) { skipped++; continue; }
      if (DRY_RUN) {
        console.log(`• [DRY] create ${keyFor(sub)} pref=${sub.prefSeatId} prev=${sub.previousSeasonSeats.length}`);
      } else {
        await Subscriber.create(sub);
      }
      created++;
    } else {
      if (DRY_RUN) {
        console.log(`↺ [DRY] update ${keyFor(sub)} pref=${sub.prefSeatId} prev=${sub.previousSeasonSeats.length}`);
      } else {
        existing.set(sub);
        await existing.save();
      }
      updated++;
    }
  }

  console.log(`[import-subscribers] done. created=${created}, updated=${updated}, skipped=${skipped}${DRY_RUN ? ' (dryRun)' : ''}`);
  await mongoose.disconnect();
}

run().catch(e => {
  console.error('[import-subscribers] fatal:', e);
  process.exit(1);
});
