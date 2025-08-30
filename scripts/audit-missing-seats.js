// scripts/audit-missing-seats.js
// Usage:
//   node scripts/audit-missing-seats.js <seasonCode> [venueSlug] [--out=missing-seats.csv] [--grouped=grouped-missing.csv] [--verbose]
//
// - seasonCode : obligatoire (ex: 2025-2026)
// - venueSlug  : facultatif ; si omis, on tente de le lire dans Season(venueSlug)
// - --out      : fichier CSV détaillé (email,firstName,lastName,seatId,inCatalog,reason)
// - --grouped  : fichier CSV groupé par email (email,firstName,lastName,missingSeats)
// - --verbose  : logs supplémentaires
//
// Objectif : lister les seatId présents dans subscribers.previousSeasonSeats mais absents de seats(seasonCode)
//            et indiquer s'ils existent dans le SeatCatalog (si venueSlug connu).
//

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

import { Season } from '../src/models/Season.js';

import dotenv from 'dotenv';
dotenv.config();


function parseArgs() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node scripts/audit-missing-seats.js <seasonCode> [venueSlug] [--out=missing-seats.csv] [--grouped=grouped-missing.csv] [--verbose]');
    process.exit(1);
  }
  const seasonCode = args[0];
  let venueSlug = null;
  if (args[1] && !args[1].startsWith('--')) venueSlug = args[1];

  let out = 'missing-seats.csv';
  let grouped = null;
  let verbose = false;
  for (const a of args) {
    if (a.startsWith('--out=')) out = a.split('=')[1];
    else if (a.startsWith('--grouped=')) grouped = a.split('=')[1];
    else if (a === '--verbose') verbose = true;
  }
  return { seasonCode, venueSlug, out, grouped, verbose };
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

(async () => {
  const { seasonCode, venueSlug: venueSlugArg, out, grouped, verbose } = parseArgs();
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGO_URI/MONGODB_URI manquant dans .env');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);

  // Récupérer venueSlug depuis la saison si non fourni
  let venueSlug = venueSlugArg;
  if (!venueSlug) {
    const season = await Season.findOne({ code: seasonCode }, { venueSlug: 1 }).lean();
    venueSlug = season?.venueSlug || null;
    if (verbose) console.log(`[i] Season ${seasonCode} -> venueSlug=${venueSlug || '(null)'}`);
  }

  // Pipeline d'audit
  const pipeline = [
    { $project: { email: 1, firstName: 1, lastName: 1, previousSeasonSeats: 1 } },
    { $unwind: '$previousSeasonSeats' },
    // Normalisation basique (trim + uppercase)
    { $set: {
        seatId: {
          $toUpper: {
            $trim: { input: '$previousSeasonSeats' }
          }
        }
      }
    },
    // 1) Existe dans seats(seasonCode) ?
    { $lookup: {
        from: 'seats',
        let: { sid: '$seatId' },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$seasonCode', seasonCode] },
            { $eq: ['$seatId', '$$sid'] }
          ] } } }
        ],
        as: 'seasonSeat'
    }},
    { $match: { seasonSeat: { $size: 0 } } }
  ];

  const checkCatalog = Boolean(venueSlug);
  if (checkCatalog) {
    pipeline.push(
      { $lookup: {
          from: 'seatcatalogs',
          let: { sid: '$seatId' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$venueSlug', venueSlug] },
              { $eq: ['$seatId', '$$sid'] }
            ] } } }
          ],
          as: 'catalogSeat'
      }},
      { $project: {
          _id: 0,
          email: 1, firstName: 1, lastName: 1,
          seatId: 1,
          inCatalog: { $gt: [{ $size: '$catalogSeat' }, 0] }
      } }
    );
  } else {
    pipeline.push(
      { $project: {
          _id: 0,
          email: 1, firstName: 1, lastName: 1,
          seatId: 1,
          inCatalog: { $literal: null } // inconnu faute de venueSlug
      } }
    );
  }

  const coll = mongoose.connection.collection('subscribers');
  const cursor = coll.aggregate(pipeline, { allowDiskUse: true });

  let rows = [];
  for await (const d of cursor) {
    const reason = (d.inCatalog === true) ? 'not_instantiated' :
                   (d.inCatalog === false) ? 'unknown_seat' : 'unknown'; // null => venueSlug inconnu
    rows.push({
      email: d.email || '',
      firstName: d.firstName || '',
      lastName: d.lastName || '',
      seatId: d.seatId || '',
      inCatalog: d.inCatalog,
      reason
    });
  }

  // Tri stable par email puis seatId
  rows.sort((a, b) => (a.email || '').localeCompare(b.email || '') || (a.seatId || '').localeCompare(b.seatId || ''));

  // Écriture CSV détaillé
  const outPath = path.resolve(out);
  const header = 'email,firstName,lastName,seatId,inCatalog,reason\n';
  const body = rows.map(r => [
    csvEscape(r.email),
    csvEscape(r.firstName),
    csvEscape(r.lastName),
    csvEscape(r.seatId),
    (r.inCatalog === null ? '' : r.inCatalog ? 'true' : 'false'),
    csvEscape(r.reason)
  ].join(',')).join('\n');
  fs.writeFileSync(outPath, header + body + (body && !body.endsWith('\n') ? '\n' : ''), 'utf8');

  // Écriture CSV groupé optionnel
  if (grouped) {
    const gmap = new Map(); // email -> { firstName, lastName, seats:Set, unknown:Set, notInst:Set }
    for (const r of rows) {
      const k = r.email || '(no-email)';
      const entry = gmap.get(k) || { firstName: r.firstName || '', lastName: r.lastName || '', seats: new Set(), unknown: new Set(), notInst: new Set() };
      entry.seats.add(r.seatId);
      if (r.reason === 'unknown_seat') entry.unknown.add(r.seatId);
      if (r.reason === 'not_instantiated') entry.notInst.add(r.seatId);
      gmap.set(k, entry);
    }
    const groupedPath = path.resolve(grouped);
    const gHeader = 'email,firstName,lastName,missingSeats,unknownSeats,notInstantiated\n';
    const gBody = Array.from(gmap.entries()).map(([email, e]) => {
      const list = Array.from(e.seats).sort().join(';');
      const unk  = Array.from(e.unknown).sort().join(';');
      const noti = Array.from(e.notInst).sort().join(';');
      return [csvEscape(email), csvEscape(e.firstName), csvEscape(e.lastName), csvEscape(list), csvEscape(unk), csvEscape(noti)].join(',');
    }).join('\n');
    fs.writeFileSync(groupedPath, gHeader + gBody + (gBody && !gBody.endsWith('\n') ? '\n' : ''), 'utf8');
  }

  // Stats
  const total = rows.length;
  const nUnknown = rows.filter(r => r.inCatalog === false).length;
  const nNotInst = rows.filter(r => r.inCatalog === true).length;
  console.log(`Audit terminé: ${total} lignes.`);
  console.log(` - unknown_seat (absent du catalogue ${venueSlug || 'n/a'}): ${nUnknown}`);
  console.log(` - not_instantiated (existe en catalogue mais pas instancié en saison ${seasonCode}): ${nNotInst}`);
  console.log(`CSV détaillé: ${outPath}`);
  if (grouped) console.log(`CSV groupé: ${path.resolve(grouped)}`);

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
