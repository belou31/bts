/**
 * Export renewal groups with JWT tokens.
 *
 * Usage:
 *   node scripts/03-season-management/export-renew-groups.js <seasonCode> --venue=<slug> --base=<https://host/bts> [--out=renew-groups.csv]
 *
 * Environment:
 *   - MONGO_URI (required)
 *   - JWT_SECRET (required)
 *
 * Templates:
 *   - data_references/csv/renew-groups.template.csv
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

import { Subscriber } from '../../src/models/Subscriber.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function parseArgs() {
  const [,, seasonCode, ...rest] = process.argv;
  if (!seasonCode) {
    console.error('Usage: node scripts/03-season-management/export-renew-groups.js <seasonCode> --venue=<slug> --out=<file.csv> --base=<https://host/bts>');
    process.exit(1);
  }
  const params = { seasonCode };
  for (const a of rest) {
    if (a.startsWith('--venue=')) params.venueSlug = a.split('=')[1];
    else if (a.startsWith('--out=')) params.out = a.split('=')[1];
    else if (a.startsWith('--base=')) params.base = a.split('=')[1];
  }
  if (!params.venueSlug) {
    console.error('ERROR: --venue=<slug> obligatoire');
    process.exit(1);
  }
  if (!params.base) {
    console.error('ERROR: --base=<urlBase> (ex: https://billetterie-test.belougas.fr/bts) obligatoire');
    process.exit(1);
  }
  params.out = params.out || `renew-groups-${seasonCode}-${params.venueSlug}.csv`;
  return params;
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

async function main() {
  const { seasonCode, venueSlug, base, out } = parseArgs();
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET manquant');

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGO_URI/MONGODB_URI manquant');
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(mongoUri, connectOpts);

  const subs = await Subscriber.find({ seasonCode, venueSlug }).lean().exec();
  if (!subs.length) {
    console.error(`Aucun subscriber pour season=${seasonCode}, venue=${venueSlug}`);
  }

  // Regroupement par groupKey (fallback email)
  const groups = new Map();
  for (const s of subs) {
    const key = s.groupKey || s.email || s._id.toString();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const lines = [];
  // En-tête CSV
  lines.push(['groupKey','email','seatIds','token','url'].join(';'));

  for (const [groupKey, arr] of groups.entries()) {
    // Email "contact" = premier ayant un email
    const contact = arr.find(x => x.email) || arr[0];
    const email = (contact?.email || '').trim();

    // Collecte des seats (previousSeasonSeats + prefSeatId)
    const seatIds = uniq(arr.flatMap(x => [
      ...(Array.isArray(x.previousSeasonSeats) ? x.previousSeasonSeats : []),
      x.prefSeatId
    ]));

    if (!seatIds.length) continue; // rien à renouveler

    const payload = {
      seasonCode,
      venueSlug,
      email,
      groupKey,
      seatIds,
      iat: Math.floor(Date.now()/1000),
      exp: Math.floor(Date.now()/1000) + 60*60*24*30 // 30 jours
    };
    const token = jwt.sign(payload, secret);
    const url = `${base.replace(/\/+$/,'')}/renew?id=${token}`;
    lines.push([groupKey, email, seatIds.join(','), token, url].join(';'));
  }

  const OUTPUT_DIR = path.resolve(process.cwd(), 'data/outputs');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.isAbsolute(out) ? out : path.join(OUTPUT_DIR, out);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`OK: ${lines.length-1} groupes exportés -> ${outPath}`);

  await mongoose.disconnect();
}
await main().catch(async (err) => {
  console.error('[export-renew-groups] Erreur:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
