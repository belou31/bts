#!/usr/bin/env node
/**
 * Import renewal subscribers (flat CSV)
 *
 * Each CSV line represents a single seat/subscriber entry to upsert.
 *
 * Usage:
 *   node scripts/03-season-management/import-renewers-flat.js <csvPath> <seasonCode> --venue=<slug> [--extra=<n>]
 *
 * Accepted columns (case-insensitive):
 *   firstName,lastName,email,phone,seasonCode,venueSlug,seatId|prefSeatId|seat,group,extra
 * - If group is empty → groupKey falls back to a normalized email.
 * - Upsert key: (email, seasonCode, venueSlug, prefSeatId)
 * - extra = places supplémentaires que ce renouveleur peut prendre en plus de
 *   ses sièges précédents. Colonne CSV prioritaire ; --extra=<n> sert de valeur
 *   par défaut pour les lignes sans colonne/valeur. Défaut final : 0.
 *   ⚠ Le quota d'un lien de renouvellement est calculé par groupKey en prenant
 *   le MAX des extra du groupe (jamais la somme) — voir export-renew-groups.js.
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI: Mongo database connection (required)
 *
 * Templates:
 *   - data_references/csv/renew-subscribers.template.csv
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import mongoose from 'mongoose';

import { Subscriber } from '../../src/models/Subscriber.js';

import dotenv from 'dotenv';
dotenv.config();

function die(msg) { console.error(msg); process.exit(1); }

const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');

function resolveInputFile(p) {
  if (!p) return p;
  const absolute = path.resolve(p);
  if (fs.existsSync(absolute)) return absolute;
  const fromInputs = path.resolve(INPUT_DIR, p);
  if (fs.existsSync(fromInputs)) return fromInputs;
  return absolute;
}

function parseArgs(argv) {
  const [,, csvPath, seasonCode, ...rest] = argv;
  const args = { csvPath, seasonCode, venueSlug: null, extra: 0 };
  for (const t of rest) {
    const venue = /^--venue=(.+)$/.exec(t);
    if (venue) { args.venueSlug = venue[1]; continue; }
    const extra = /^--extra=(.+)$/.exec(t);
    if (extra) args.extra = normExtra(extra[1]);
  }
  return args;
}

// Non-numeric / negative / absent → 0 rather than NaN reaching the schema.
function normExtra(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
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
  const extraCol  = pick('extra','extras','supplement','supplementaire');

  const missing = [];
  if (email  < 0) missing.push('email');
  if (seatId < 0) missing.push('seatId (ou prefSeatId|seat)');
  if (missing.length) {
    throw new Error(`Colonnes manquantes: ${missing.join(', ')}. Vues: ${h.join(', ')}`);
  }
  return { header: h, lc, firstName, lastName, email, phone, seatId, group, seasonCol, venueCol, extraCol, delim };
}

function normGroupKey(v) {
  const s = String(v || '').trim().toLowerCase();
  return s.replace(/\s+/g, '_');
}

(async () => {
  const { csvPath, seasonCode, venueSlug, extra: extraDefault } = parseArgs(process.argv);
  if (!csvPath || !seasonCode) {
    die('Usage: node scripts/03-season-management/import-renewers-flat.js <csvPath> <seasonCode> --venue=<slug> [--extra=<n>]');
  }

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) die('Missing MONGO_URI in .env');

  await mongoose.connect(mongoUri);

  const full = resolveInputFile(csvPath);
  if (!fs.existsSync(full)) die(`CSV not found: ${csvPath} (cherché dans ${full} et data/inputs)`);

  // Lire la 1ère ligne pour trouver le délimiteur
  // Le délimiteur se déduit de l'EN-TÊTE, donc de la première ligne utile :
  // une ligne de commentaire fausserait la détection.
  const firstLine = stripBOM(
    fs.readFileSync(full, 'utf8').split(/\r?\n/)
      .find(l => l.trim().length && !l.trimStart().startsWith('#'))
  );
  if (!firstLine) die('CSV vide');
  const delim = detectDelimiter(firstLine);

  const rl = readline.createInterface({ input: fs.createReadStream(full, 'utf8'), crlfDelay: Infinity });

  let header = null, cols = null, scanned = 0, upserts = 0, modified = 0, skipped = 0;
  const rows = new Map();   // clé (email, saison, lieu, seatId) -> ligne agrégée
  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    // Lignes de commentaire du gabarit. Sans cela, la première ligne « # … »
    // serait prise pour l'en-tête et aucune colonne ne serait reconnue.
    if (line.trimStart().startsWith('#')) continue;

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
    const extraCSV  = take(cols.extraCol);
    const extra     = extraCSV !== '' ? normExtra(extraCSV) : extraDefault;

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

    // On agrège AVANT d'écrire, au lieu d'upserter ligne à ligne.
    //
    // La clé d'upsert contient prefSeatId : deux places dans la même zone
    // donnent deux lignes CSV identiques, donc la seconde écrasait la première
    // et la place disparaissait. Compter d'abord, écrire ensuite, garde aussi
    // l'import idempotent — relancer le même fichier REMET le compte, il ne
    // l'incrémente pas.
    const key = [email, season, venue, seatId].join('\u0000');
    const found = rows.get(key);
    if (found) {
      found.places += 1;
      // Dernière ligne gagnante sur les champs d'identité, comme avant.
      Object.assign(found, { firstName, lastName, phone, groupKey, extra });
    } else {
      rows.set(key, { email, season, venue, seatId, firstName, lastName, phone, groupKey, extra, places: 1 });
    }
  }

  for (const r of rows.values()) {
    const where = { email: r.email, seasonCode: r.season, venueSlug: r.venue, prefSeatId: r.seatId };
    const update = {
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      phone: r.phone,
      prefSeatId: r.seatId,
      seasonCode: r.season,
      venueSlug: r.venue,
      groupKey: r.groupKey,
      extra: r.extra,
      places: r.places,
      status: 'invited',
      $addToSet: { previousSeasonSeats: r.seatId }
    };

    const res = await Subscriber.updateOne(where, update, { upsert: true });
    if (res.upsertedCount > 0) upserts++;
    else if (res.modifiedCount > 0) modified++;
  }

  const grouped = [...rows.values()].filter(r => r.places > 1);
  if (grouped.length) {
    console.log('Places multiples sur une même cible (zones) :');
    for (const r of grouped) console.log(`  ${r.email} — ${r.seatId} : ${r.places} places`);
  }
  console.log(`Done. scanned=${scanned} lignes=${rows.size} upserts=${upserts} modified=${modified} skipped=${skipped}`);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('ERROR', e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
