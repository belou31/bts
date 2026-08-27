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
 * Une méta-zone décrit la SALLE, pas une saison : elle se pose sur le
 * catalogue de zones du lieu (ZoneCatalog), avant qu'aucune saison n'existe.
 * `instantiate-venue-for-season.js` la recopie ensuite sur les zones de chaque
 * saison instanciée. D'où l'absence de --season ici : dans l'ordre logique du
 * paramétrage, la saison vient après.
 *
 * --season reste disponible, mais uniquement pour répercuter un changement sur
 * une saison DÉJÀ instanciée, sans avoir à la réinstancier.
 *
 * Usage:
 *   node scripts/01-venue-management/set-zone-meta.js --venue=stadium \
 *     --meta=S_LOW --zones=S1,S3
 *
 *   # retirer les zones d'une méta-zone
 *   node scripts/01-venue-management/set-zone-meta.js --venue=stadium --clear --zones=S3
 *
 *   # depuis un CSV (zoneKey,metaZone) — metaZone vide = retire
 *   node scripts/01-venue-management/set-zone-meta.js --venue=stadium \
 *     --csv=data/inputs/meta-zones.csv
 *
 *   # répercuter aussi sur une saison déjà instanciée
 *   node scripts/01-venue-management/set-zone-meta.js --venue=stadium \
 *     --meta=S_LOW --zones=S1,S3 --season=2025-2026
 *
 *   # état des lieux (ajouter --season pour voir aussi les grilles tarifaires)
 *   node scripts/01-venue-management/set-zone-meta.js --venue=stadium --list
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
import { ZoneCatalog } from '../../src/models/ZoneCatalog.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';

import dotenv from 'dotenv';
dotenv.config();

const list = (v) => String(v || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('venue', { type: 'string', demandOption: true, desc: 'Slug du lieu' })
    .option('season', { type: 'string', desc: 'Répercuter aussi sur cette saison déjà instanciée (optionnel)' })
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

  const venueSlug = argv.venue;
  const seasonCode = argv.season || null;   // propagation explicite, facultative

  /** Écrit sur le catalogue du lieu, puis — si demandé — sur la saison. */
  async function applyMeta(zoneKeys, metaZone) {
    const cat = await ZoneCatalog.updateMany(
      { venueSlug, key: { $in: zoneKeys } },
      { $set: { metaZone } }
    );
    let season = null;
    if (seasonCode) {
      const res = await Zone.updateMany(
        { seasonCode, venueSlug, key: { $in: zoneKeys } },
        { $set: { metaZone } }
      );
      season = res.modifiedCount ?? 0;
    }
    return { catalog: cat.modifiedCount ?? 0, season };
  }

  /** Les zones du lieu — le catalogue fait foi, la saison n'existe pas encore. */
  async function knownZoneKeys() {
    const rows = await ZoneCatalog.find({ venueSlug }, 'key').lean();
    return new Set(rows.map(z => String(z.key).toUpperCase()));
  }

  if (argv.list) {
    const zones = await ZoneCatalog.find({ venueSlug }, 'key name metaZone').sort({ key: 1 }).lean();
    console.log(`Catalogue de zones de ${venueSlug} :`);
    if (!zones.length) console.log('  (aucune zone — lancer import-zones.js d\'abord)');
    for (const z of zones) {
      console.log(`  ${String(z.key).padEnd(10)} ${String(z.metaZone || '—').padEnd(8)} ${z.name || ''}`);
    }

    // Les grilles tarifaires par méta-zone sont, elles, propres à une saison :
    // on ne les affiche que si l'on en nomme une.
    if (seasonCode) {
      const seasonZones = await Zone.find({ seasonCode, venueSlug }, 'key metaZone').sort({ key: 1 }).lean();
      console.log(`\nZones instanciées pour ${seasonCode} :`);
      if (!seasonZones.length) console.log('  (saison non instanciée)');
      for (const z of seasonZones) {
        console.log(`  ${String(z.key).padEnd(10)} ${String(z.metaZone || '—')}`);
      }
      const prices = await TariffPrice.find(
        { seasonCode, venueSlug, metaZone: { $ne: null } },
        'metaZone tariffCode priceCents'
      ).lean();
      if (prices.length) {
        console.log('\nGrilles définies par méta-zone :');
        for (const p of prices) {
          console.log(`  ${String(p.metaZone).padEnd(8)} ${String(p.tariffCode).padEnd(10)} ${(p.priceCents / 100).toFixed(2)} €`);
        }
      } else {
        console.log('\n(aucune grille par méta-zone pour cette saison)');
      }
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

    const known = await knownZoneKeys();
    const missing = rows.map(r => r.zoneKey).filter(k => !known.has(k));
    if (missing.length) {
      // Même exigence qu'en mode --zones : une faute de frappe rendrait la
      // grille par méta-zone inopérante sans le dire.
      throw new Error(`Zone(s) introuvable(s) dans le catalogue de ${venueSlug} : ${[...new Set(missing)].join(', ')}`);
    }

    let changed = 0;
    let changedSeason = 0;
    for (const row of rows) {
      console.log(`${argv['dry-run'] ? '·' : '✅'} ${row.zoneKey} → ${row.metaZone || '—'}`);
      if (!argv['dry-run']) {
        const res = await applyMeta([row.zoneKey], row.metaZone);
        changed += res.catalog;
        changedSeason += (res.season ?? 0);
      }
    }
    console.log(argv['dry-run']
      ? `\n${rows.length} ligne(s) — dry-run, relancer sans --dry-run pour écrire.`
      : `${changed} zone(s) mise(s) à jour au catalogue sur ${rows.length} ligne(s).`
        + (seasonCode ? ` ${changedSeason} répercutée(s) sur ${seasonCode}.` : ''));
    await mongoose.disconnect();
    return;
  }

  const zones = list(argv.zones);
  if (!zones.length) throw new Error('--zones requis (ou --csv, ou --list)');
  if (!argv.clear && !argv.meta) throw new Error('--meta requis (ou --clear)');

  const metaZone = argv.clear ? null : String(argv.meta).trim().toUpperCase();

  const existing = await ZoneCatalog.find({ venueSlug, key: { $in: zones } }, 'key metaZone').lean();
  const found = new Set(existing.map(z => String(z.key).toUpperCase()));
  const missing = zones.filter(z => !found.has(z));
  if (missing.length) {
    // Bloquant : une faute de frappe passerait sinon inaperçue, et la grille
    // par méta-zone ne s'appliquerait jamais à la zone qu'on croyait viser.
    throw new Error(`Zone(s) introuvable(s) dans le catalogue de ${venueSlug} : ${missing.join(', ')}`);
  }

  for (const z of existing) {
    const from = z.metaZone || '—';
    console.log(`${argv['dry-run'] ? '·' : '✅'} ${z.key} : ${from} → ${metaZone || '—'}`);
  }

  if (!argv['dry-run']) {
    const res = await applyMeta(zones, metaZone);
    console.log(`${res.catalog} zone(s) mise(s) à jour au catalogue de ${venueSlug}.`);
    if (seasonCode) {
      console.log(`${res.season} zone(s) répercutée(s) sur ${seasonCode}.`);
    } else {
      console.log('→ les saisons instanciées ensuite hériteront de ces méta-zones.');
    }
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
