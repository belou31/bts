// scripts/import-subscribers.js
// Usage:
//   node scripts/import-subscribers.js <path/to/subscribers.csv> <seasonCode> [--dry-run] [--no-seat-check] [--verbose]
//
// CSV attendu (en-têtes insensibles à la casse) :
//   firstName,lastName,email,phone,previousSeasonSeats
// Exemple previousSeasonSeats: A1-001;A1-002
//
// Effets : upsert des abonnés par email + mise à jour de previousSeasonSeats (nettoyé/dédupliqué).
// Optionnel : vérifie que les seatId existent dans la collection "seats" pour la saison fournie.

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

import { Subscriber } from '../../src/models/Subscriber.js';
import { Seat } from '../../src/models/Seat.js';

import dotenv from 'dotenv';
dotenv.config();


function parseArgs() {
  const [csvPath, seasonCode, ...flags] = process.argv.slice(2);
  if (!csvPath || !seasonCode) {
    console.error('Usage: node scripts/import-subscribers.js <path/to/subscribers.csv> <seasonCode> [--dry-run] [--no-seat-check] [--verbose]');
    process.exit(1);
  }
  return {
    csvPath,
    seasonCode,
    dryRun: flags.includes('--dry-run'),
    seatCheck: !flags.includes('--no-seat-check'),
    verbose: flags.includes('--verbose'),
  };
}

// Petit parseur CSV qui gère les champs entre guillemets et les virgules internes.
function parseCsvText(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            cur += '"'; i++; // échappe ""
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          out.push(cur);
          cur = '';
        } else {
          cur += ch;
        }
      }
    }
    out.push(cur);
    return out.map(s => s.trim());
  };

  const headers = parseLine(lines[0]).map(h => h.trim());
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

function indexHeaders(headers) {
  const idx = {};
  headers.forEach((h, i) => { idx[h.toLowerCase()] = i; });
  const need = ['firstname', 'lastname', 'email', 'phone', 'previousseasonseats'];
  const missing = need.filter(k => !(k in idx));
  if (missing.length) {
    throw new Error(`Colonnes manquantes dans le CSV : ${missing.join(', ')}. En-têtes vus: ${headers.join(', ')}`);
  }
  return idx;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function normalizeSeats(raw) {
  // Accepte séparateurs ; , ou espaces multiples (mais on encourage ;)
  const s = String(raw || '').trim();
  if (!s) return [];
  const parts = s.split(/[;,\s]+/).map(x => x.trim()).filter(Boolean);
  const up = parts.map(x => x.toUpperCase());
  // Déduplication en conservant l'ordre
  const seen = new Set();
  const out = [];
  for (const v of up) {
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

(async () => {
  const { csvPath, seasonCode, dryRun, seatCheck, verbose } = parseArgs();

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGO_URI/MONGODB_URI manquant dans .env');
    process.exit(1);
  }

  // Lecture CSV
  const fullPath = path.resolve(csvPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`CSV introuvable: ${fullPath}`);
    process.exit(1);
  }
  const text = fs.readFileSync(fullPath, 'utf8').replace(/^\uFEFF/, ''); // strip BOM
  const { headers, rows } = parseCsvText(text);
  const idx = indexHeaders(headers);

  console.log(`Importing subscribers from ${path.basename(fullPath)} for season ${seasonCode}...`);
  console.log(`Options: dryRun=${dryRun} seatCheck=${seatCheck} verbose=${verbose}`);

  await mongoose.connect(mongoUri);

  let total = 0, created = 0, updated = 0, skippedNoEmail = 0, seatMissing = 0;
  const seatMissingMap = new Map(); // email -> [seatId...]

  for (const row of rows) {
    total++;
    const firstName = row[idx['firstname']] || '';
    const lastName  = row[idx['lastname']]  || '';
    const email     = normalizeEmail(row[idx['email']]);
    const phone     = (row[idx['phone']] || '').trim();
    const prevSeats = normalizeSeats(row[idx['previousseasonseats']]);

    if (!email) { skippedNoEmail++; if (verbose) console.warn(`Ligne ${total}: email manquant, ignoré`); continue; }

    // Vérif optionnelle des seats dans la saison cible
    if (seatCheck && prevSeats.length) {
      const missing = [];
      // On vérifie l’existence basique par seatId + seasonCode
      const found = await Seat.find(
        { seasonCode, seatId: { $in: prevSeats } },
        { seatId: 1 }
      ).lean();
      const foundSet = new Set(found.map(x => x.seatId));
      for (const s of prevSeats) {
        if (!foundSet.has(s)) missing.push(s);
      }
      if (missing.length) {
        seatMissing += missing.length;
        seatMissingMap.set(email, (seatMissingMap.get(email) || []).concat(missing));
        if (verbose) console.warn(`Seats manquants pour ${email}: ${missing.join(', ')}`);
      }
    }

    if (dryRun) {
      if (verbose) {
        console.log(`[DRY] upsert ${email} -> prevSeats=[${prevSeats.join(';')}] first="${firstName}" last="${lastName}" phone="${phone}"`);
      }
      continue;
    }

    const res = await Subscriber.findOneAndUpdate(
      { email },
      {
        $set: {
          firstName,
          lastName,
          phone,
          previousSeasonSeats: prevSeats
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true, new: true }
    ).lean();

    // Déterminer created/updated grossièrement : si le doc avait un _id avant ?
    // Comme on ne l'a pas, on peut refaire une lecture préalable, mais pour rester simple :
    // On compte "updated" si le findOneAndUpdate a modifié un doc existant.
    // Trick: refait une recherche rapide by email pour voir s'il existait (coût minime pour petits volumes)
    // => Simplifions: si prevSeats vide ET nouvel abonné, peu probable. On fait un second check:
    const existed = await Subscriber.exists({ email, createdAt: { $lt: new Date(Date.now() - 1000) } });
    if (existed) updated++; else created++;
  }

  await mongoose.disconnect();

  // Résumé
  console.log('---');
  console.log(`Total lignes:          ${total}`);
  console.log(`Créés:                 ${created}`);
  console.log(`Mises à jour:          ${updated}`);
  console.log(`Ignorés (sans email):  ${skippedNoEmail}`);
  if (seatCheck) {
    console.log(`Seats manquants (total): ${seatMissing}`);
    if (seatMissingMap.size && verbose) {
      console.log('Détail seats manquants par email:');
      for (const [email, list] of seatMissingMap.entries()) {
        console.log(` - ${email}: ${Array.from(new Set(list)).join(', ')}`);
      }
    }
  }
  if (dryRun) {
    console.log('(dry run: aucune écriture en base)');
  }
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
