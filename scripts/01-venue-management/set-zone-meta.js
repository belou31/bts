/**
 * Rattache des zones à une MÉTA-ZONE.
 *
 * Une méta-zone regroupe des zones ; elle n'existe pas sur le plan (aucun
 * sélecteur SVG, aucun siège), c'est un regroupement logique. Le premier usage
 * est tarifaire — la grille s'écrit UNE fois pour la méta-zone
 * (import-tariff-prices.js, colonne `metaZone`) au lieu d'être recopiée zone
 * par zone, et une zone rattachée plus tard hérite du prix sans retoucher la
 * grille — mais ce n'est qu'un usage : un bon cadeau peut aussi être limité à
 * une méta-zone.
 *
 * Usage:
 *   node scripts/01-venue-management/set-zone-meta.js --season=2025-2026 --venue=stadium \
 *     --meta=S_LOW --zones=S1,S3
 *
 *   # retirer les zones d'une méta-zone
 *   node scripts/01-venue-management/set-zone-meta.js --season=2025-2026 --venue=stadium \
 *     --clear --zones=S3
 *
 *   # depuis un CSV (zoneKey,metaZone) — metaZone vide = retire
 *   node scripts/01-venue-management/set-zone-meta.js --season=2025-2026 --venue=stadium \
 *     --csv=data/inputs/meta-zones.csv
 *
 *   # état des lieux
 *   node scripts/01-venue-management/set-zone-meta.js --season=2025-2026 --venue=stadium --list
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import fs from 'node:fs';
import path from 'node:path';

import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { Zone } from '../../src/models/Zone.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';

import dotenv from 'dotenv';
dotenv.config();

const list = (v) => String(v || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('season', { type: 'string', demandOption: true, desc: 'Code saison' })
    .option('venue', { type: 'string', demandOption: true, desc: 'Slug du lieu' })
    .option('zones', { type: 'string', desc: 'Zones visées, séparées par des virgules' })
    .option('meta', { type: 'string', desc: 'Méta-zone à poser (ex: S_LOW)' })
    .option('clear', { type: 'boolean', default: false, desc: 'Retire la méta-zone des zones visées' })
    .option('list', { type: 'boolean', default: false, desc: 'Affiche les méta-zones en place' })
    .option('csv', { type: 'string', desc: 'CSV zoneKey,metaZone (colonne vide = retire)' })
    .option('dry-run', { type: 'boolean', default: false })
    .help().argv;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  const opts = {};
  if (process.env.MONGODB_DB) opts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, opts);

  const seasonCode = argv.season;
  const venueSlug = argv.venue;

  if (argv.list) {
    const zones = await Zone.find({ seasonCode, venueSlug }, 'key name metaZone').sort({ key: 1 }).lean();
    const prices = await TariffPrice.find(
      { seasonCode, venueSlug, metaZone: { $ne: null } },
      'metaZone tariffCode priceCents'
    ).lean();

    console.log(`Zones de ${seasonCode} / ${venueSlug} :`);
    for (const z of zones) {
      console.log(`  ${String(z.key).padEnd(10)} ${String(z.metaZone || '—').padEnd(8)} ${z.name || ''}`);
    }
    if (prices.length) {
      console.log('\nGrilles définies par méta-zone :');
      for (const p of prices) {
        console.log(`  ${String(p.metaZone).padEnd(8)} ${String(p.tariffCode).padEnd(10)} ${(p.priceCents / 100).toFixed(2)} €`);
      }
    } else {
      console.log('\n(aucune grille par méta-zone pour l\'instant)');
    }
    await mongoose.disconnect();
    return;
  }

  // — Mode CSV : une ligne par zone. Utile pour poser un plan de méta-zones
  // complet d'un coup, plutôt qu'une commande par méta-zone.
  if (argv.csv) {
    const resolved = path.isAbsolute(argv.csv)
      ? argv.csv
      : [path.resolve(process.cwd(), argv.csv), path.resolve(process.cwd(), 'data', 'inputs', argv.csv)]
          .find(p => fs.existsSync(p));
    if (!resolved || !fs.existsSync(resolved)) throw new Error(`CSV introuvable : ${argv.csv}`);

    const rows = [];
    const raw = fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '');
    for (const [i, line] of raw.split(/\r?\n/).entries()) {
      const text = line.trim();
      if (!text || text.startsWith('#')) continue;               // commentaires du template
      const cells = text.split(/[;,\t]/).map(c => c.trim());
      const first = cells[0].toUpperCase();
      if (i === 0 && (first === 'ZONEKEY' || first === 'ZONE' || first === 'KEY')) continue;  // en-tête
      if (!first) continue;
      rows.push({ zoneKey: first, metaZone: (cells[1] || '').trim().toUpperCase() || null });
    }
    if (!rows.length) throw new Error('CSV vide (aucune ligne exploitable)');

    const known = new Set(
      (await Zone.find({ seasonCode, venueSlug }, 'key').lean()).map(z => String(z.key).toUpperCase())
    );
    const missing = rows.map(r => r.zoneKey).filter(k => !known.has(k));
    if (missing.length) {
      // Même exigence qu'en mode --zones : une faute de frappe rendrait la
      // grille par méta-zone inopérante sans le dire.
      throw new Error(`Zone(s) introuvable(s) pour ${seasonCode}/${venueSlug} : ${[...new Set(missing)].join(', ')}`);
    }

    let changed = 0;
    for (const row of rows) {
      console.log(`${argv['dry-run'] ? '·' : '✅'} ${row.zoneKey} → ${row.metaZone || '—'}`);
      if (!argv['dry-run']) {
        const res = await Zone.updateOne(
          { seasonCode, venueSlug, key: row.zoneKey },
          { $set: { metaZone: row.metaZone } }
        );
        changed += (res.modifiedCount ?? 0);
      }
    }
    console.log(argv['dry-run']
      ? `\n${rows.length} ligne(s) — dry-run, relancer sans --dry-run pour écrire.`
      : `${changed} zone(s) mise(s) à jour sur ${rows.length} ligne(s).`);
    await mongoose.disconnect();
    return;
  }

  const zones = list(argv.zones);
  if (!zones.length) throw new Error('--zones requis (ou --csv, ou --list)');
  if (!argv.clear && !argv.meta) throw new Error('--meta requis (ou --clear)');

  const metaZone = argv.clear ? null : String(argv.meta).trim().toUpperCase();

  const existing = await Zone.find({ seasonCode, venueSlug, key: { $in: zones } }, 'key metaZone').lean();
  const found = new Set(existing.map(z => String(z.key).toUpperCase()));
  const missing = zones.filter(z => !found.has(z));
  if (missing.length) {
    // Bloquant : une faute de frappe passerait sinon inaperçue, et la grille
    // par méta-zone ne s'appliquerait jamais à la zone qu'on croyait viser.
    throw new Error(`Zone(s) introuvable(s) pour ${seasonCode}/${venueSlug} : ${missing.join(', ')}`);
  }

  for (const z of existing) {
    const from = z.metaZone || '—';
    console.log(`${argv['dry-run'] ? '·' : '✅'} ${z.key} : ${from} → ${metaZone || '—'}`);
  }

  if (!argv['dry-run']) {
    const res = await Zone.updateMany(
      { seasonCode, venueSlug, key: { $in: zones } },
      metaZone ? { $set: { metaZone } } : { $set: { metaZone: null } }
    );
    console.log(`${res.modifiedCount} zone(s) mise(s) à jour.`);
  } else {
    console.log('\nDry-run uniquement — relancer sans --dry-run pour écrire.');
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
