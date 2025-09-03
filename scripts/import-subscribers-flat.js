#!/usr/bin/env node
/**
 * Import "flat" : 1 ligne = 1 siège.
 * Usage:
 *   node scripts/import-subscribers-flat.js <csvPath> <seasonCode> --venue=<slug>
 *
 * Colonnes acceptées (insensibles à la casse) :
 *   firstName,lastName,email,phone,seasonCode,venueSlug,seatId|prefSeatId|seat,group
 * - Si group est vide → groupKey = email (normalisé)
 * - Upsert par (email, seasonCode, venueSlug, prefSeatId)
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import mongoose from 'mongoose';

import { Subscriber } from '../src/models/Subscriber.js';

import dotenv from 'dotenv';
dotenv.config();

function die(msg) { console.error(msg); process.exit(1); }

function parseArgs(argv) {
  const [,, csvPath, seasonCode, ...rest] = argv;
  const args = { csvPath, seasonCode, venueSlug: null };
  for (const t of rest) {
    const m = /^--venue=(.+)$/.exec(t);
    if (m) args.venueSlug = m[1];
  }
  return args;
}

// ----- CSV helpers (delimiter auto + guillemets + BOM) -----
function stripBOM(s){ return s ? s.replace(/^\uFEFF/, '') : s; }

function detectDelimiter(line) {
  let comma = 0, semi = 0, inQ = false;
  for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ) {
      if (ch === ',') comma++;
      else if (ch === ';') semi++;
    }
  }
  return semi > comma ? ';' : ','; // défaut: virgule
}

function parseCSVLine(line, delim) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i=0; i<line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i+1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// ----- Header mapping -----
function headersIndex(headerLine, delim) {
  const h = parseCSVLine(headerLine, delim).map(x => stripBOM(x).trim());
  const lc = h.map(x => x.toLowerCase());
  const idx = Object.fromEntries(lc.map((k,i) => [k, i]));

  const pick = (...names) => {
    for (const n of names) {
      const key = String(n).toLowerCase();
      if (idx[key] != null) return idx[key];
    }
    return -1;
  };

  const firstName = pick('firstname','first_name','prenom','first');
  const lastName  = pick('lastname','last_name','nom','last');
  const email     = pick('email','mail');
  const phone     = pick('phone','tel','telephone');
  const seatId    = pick('seatid','prefseatid','seat');
  const group     = pick('group','groupkey','groupe');
  const seasonCol = pick('seasoncode','season','saison');
  const venueCol  = pick('venueslug','venue','lieu');

  const missing = [];
  if (email  < 0) missing.push('email');
  if (seatId < 0) missing.push('seatId (ou prefSeatId|seat)');
  if (missing.length) {
    throw new Error(`Colonnes manquantes: ${missing.join(', ')}. Vues: ${h.join(', ')}`);
  }
  return { header: h, lc, firstName, lastName, email, phone, seatId, group, seasonCol, venueCol, delim };
}

function normGroupKey(v) {
  const s = String(v || '').trim().toLowerCase();
  return s.replace(/\s+/g, '_');
}

(async () => {
  const { csvPath, seasonCode, venueSlug } = parseArgs(process.argv);
  if (!csvPath || !seasonCode) {
    die('Usage: node scripts/import-subscribers-flat.js <csvPath> <seasonCode> --venue=<slug>');
  }

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) die('Missing MONGO_URI in .env');

  await mongoose.connect(mongoUri);

  const full = path.resolve(csvPath);
  if (!fs.existsSync(full)) die(`CSV not found: ${full}`);

  // Lire la 1ère ligne pour trouver le délimiteur
  const firstLine = stripBOM(fs.readFileSync(full, 'utf8').split(/\r?\n/).find(l => l.trim().length));
  if (!firstLine) die('CSV vide');
  const delim = detectDelimiter(firstLine);

  const rl = readline.createInterface({ input: fs.createReadStream(full, 'utf8'), crlfDelay: Infinity });

  let header = null, cols = null, scanned = 0, upserts = 0, modified = 0, skipped = 0;
  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;

    if (!header) {
      header = line;
      cols = headersIndex(header, delim);
      continue;
    }

    scanned++;
    const cells = parseCSVLine(line, cols.delim);
    const take = (i) => (i >= 0 ? (cells[i] || '').trim() : '');

    const email     = take(cols.email);
    const firstName = take(cols.firstName);
    const lastName  = take(cols.lastName);
    const phone     = take(cols.phone);
    const seatId    = take(cols.seatId);
    const groupRaw  = take(cols.group);
    const seasonCSV = take(cols.seasonCol);
    const venueCSV  = take(cols.venueCol);

    const season = seasonCSV || seasonCode;
    const venue  = venueCSV  || venueSlug;

    if (!email || !seatId) {
      console.warn('SKIP email/seatId manquant:', { email, seatId });
      skipped++; continue;
    }
    if (!venue) {
      console.warn('SKIP venueSlug manquant (colonne venueSlug ou --venue= requis):', { email, seatId });
      skipped++; continue;
    }

    const groupKey = normGroupKey(groupRaw || email);

    const where = { email, seasonCode: season, venueSlug: venue, prefSeatId: seatId };
    const update = {
      firstName,
      lastName,
      email,
      phone,
      prefSeatId: seatId,
      seasonCode: season,
      venueSlug: venue,
      groupKey,
      status: 'invited',
      $addToSet: { previousSeasonSeats: seatId }
    };

    const res = await Subscriber.updateOne(where, update, { upsert: true });
    if (res.upsertedCount > 0) upserts++;
    else if (res.modifiedCount > 0) modified++;
  }

  console.log(`Done. scanned=${scanned} upserts=${upserts} modified=${modified} skipped=${skipped}`);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('ERROR', e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
