#!/usr/bin/env node
/**
 * Exporte les sièges d'une SAISON, avec leur provisionnement et l'abonnement
 * qui les occupe.
 *
 * C'est l'état de fond : un siège vendu à l'abonnement est `booked` pour toute
 * la saison. Pour savoir qui occupe une place lors d'UN match — abonnés
 * compris, places rendues déduites — voir
 * scripts/04-event-management/export-event-seats.js.
 *
 * Écrit par défaut dans data/outputs/, comme les autres exports du projet.
 * --stdout rétablit l'ancien comportement pour un enchaînement en pipe.
 *
 * Usage:
 *   node scripts/03-season-management/export-season-seats.js [--season=<code>] [--venue=<slug>] [--zone=<key>] [--out=<fichier.csv>] [--stdout]
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 *   - MONGODB_DB (nom de base, optionnel)
 *
 * Template:
 *   - data_references/csv/seats-export.template.csv
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { exportSeatsCsv } from '../../src/services/exports.js';
import { writeCsvFile, explainWriteFailure } from '../lib/csv-output.js';

dotenv.config();

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) { console.error('MONGO_URI/MONGODB_URI manquant'); process.exit(1); }

const arg = (name) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || null;
const season = arg('season');
const venue  = arg('venue');
const zone   = arg('zone');
const outArg = arg('out');
const toStdout = process.argv.includes('--stdout');

const filterSeat  = {};
const filterOrder = {};
if (season) { filterSeat.seasonCode = season; filterOrder.seasonCode = season; }
if (venue)  { filterSeat.venueSlug  = venue;  filterOrder.venueSlug  = venue;  }
if (zone)   { filterSeat.zoneKey    = zone; }

try {
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });

  if (toStdout) {
    await exportSeatsCsv({ out: process.stdout, filterSeat, filterOrder, includeHeader: true });
  } else {
    const defaultName = ['season-seats', season || 'all', venue || null, zone || null]
      .filter(Boolean).join('-') + '.csv';
    const { path: outPath, lines } = await writeCsvFile({
      outArg, defaultName,
      writer: (stream) => exportSeatsCsv({ out: stream, filterSeat, filterOrder, includeHeader: true })
    });
    console.log(`OK: ${lines} siège(s) exporté(s) -> ${outPath}`);
  }
  await mongoose.disconnect();
} catch (err) {
  explainWriteFailure(err);
  try { await mongoose.disconnect(); } catch { /* rien de mieux à faire */ }
  process.exit(1);
}
