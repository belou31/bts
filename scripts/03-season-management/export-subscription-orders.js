#!/usr/bin/env node
/**
 * Exporte les commandes d'ABONNEMENT SAISON en CSV — souscriptions ET
 * renouvellements.
 *
 * Un renouvellement est la façon dont un abonné existant reprend sa place :
 * c'est un abonnement, pas un flux à part. Ne chercher que 'subscription'
 * laissait toute une campagne de renouvellement hors de l'export — et donnait
 * l'impression qu'il n'y avait que des commandes annulées, quand les
 * commandes abouties étaient simplement des renouvellements.
 *
 * Usage:
 *   node scripts/03-season-management/export-subscription-orders.js [--season=2025-2026] [--venue=patinoire-blagnac] [--status=paid] [--flow=subscription|renew] [--out=<fichier.csv>] [--stdout]
 *
 * Écrit par défaut dans data/outputs/, comme les autres exports du projet :
 * la sortie standard obligeait à rediriger soi-même, et depuis l'admin console
 * le CSV défilait à l'écran sans qu'aucun fichier ne soit récupérable.
 * --stdout rétablit l'ancien comportement pour un enchaînement en pipe.
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 *   - MONGODB_DB (optional database name)
 *
 * Template:
 *   - data_references/csv/orders-export.template.csv
 */

import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { exportOrdersCsv } from '../../src/services/exports.js';

dotenv.config();

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGO_URI/MONGODB_URI manquant');
  process.exit(1);
}

const season = process.argv.find(a => a.startsWith('--season='))?.split('=')[1] || null;
const venue  = process.argv.find(a => a.startsWith('--venue=')) ?.split('=')[1] || null;
const status = process.argv.find(a => a.startsWith('--status='))?.split('=')[1] || null;
const flow   = process.argv.find(a => a.startsWith('--flow='))  ?.split('=')[1] || null;
const outArg = process.argv.find(a => a.startsWith('--out='))   ?.split('=')[1] || null;
const toStdout = process.argv.includes('--stdout');

// Ce qui vaut abonnement saison. Même définition que services/event-season-sync.js
// et routes/admin (portée « Saison »), pour que les trois répondent pareil.
const SEASON_FLOWS = ['subscription', 'renew'];
const wanted = flow ? [flow] : SEASON_FLOWS;

// `phase` n'existe pas au schéma Order : mongoose l'a toujours supprimé à
// l'écriture, aucune commande n'en porte. Les clauses qui l'interrogeaient ne
// pouvaient rien ramener — retirées plutôt que laissées à croire qu'elles
// filtrent quelque chose.
const clauses = [
  {
    $or: [
      { 'origin.flow': { $in: wanted } },
      { mailTemplateKind: { $in: wanted } }
    ]
  },
  // Exclut les commandes de match dérivées d'un abonnement (event-season-sync) :
  // elles portent le seasonCode mais concernent une rencontre, pas la saison.
  { eventId: null }
];

if (season) clauses.push({ seasonCode: season });
if (venue)  clauses.push({ venueSlug: venue });
if (status) clauses.push({ status });

const filter = clauses.length === 1 ? clauses[0] : { $and: clauses };

await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });

// Script à code plat (top-level await) : sans ce filet, la moindre erreur
// d'écriture — dossier absent, droits insuffisants — sort en trace de pile,
// laisse la connexion Mongo ouverte, et n'explique rien à l'opérateur.
try {
if (toStdout) {
  await exportOrdersCsv({ out: process.stdout, filter, includeHeader: true });
  await mongoose.disconnect();
} else {
  const OUTPUT_DIR = path.resolve(process.cwd(), 'data/outputs');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const defaultName = [
    'season-orders',
    season || 'all',
    venue || null,
    flow || null,
    status || null
  ].filter(Boolean).join('-') + '.csv';
  // Résolution du chemin de sortie.
  //
  // Un chemin RELATIF contenant déjà un séparateur (« data/outputs/x.csv »,
  // la forme qu'on lit dans la doc et les formulaires) était concaténé à
  // data/outputs/ : on obtenait data/outputs/data/outputs/x.csv, un dossier
  // inexistant. Seul un nom de fichier NU est désormais résolu dans
  // data/outputs/ ; tout chemin est pris tel quel, relatif au dossier courant.
  const outPath = !outArg
    ? path.join(OUTPUT_DIR, defaultName)
    : path.isAbsolute(outArg)
      ? outArg
      : (outArg.includes(path.sep) || outArg.includes('/'))
        ? path.resolve(process.cwd(), outArg)
        : path.join(OUTPUT_DIR, outArg);

  // Le dossier cible peut ne pas exister quand --out désigne un sous-chemin.
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const stream = fs.createWriteStream(outPath, { encoding: 'utf8' });
  // Handler posé AVANT la première écriture : une erreur d'ouverture survient
  // pendant exportOrdersCsv, donc avant que la promesse ci-dessous existe —
  // sans cela le flux émet un 'error' non géré et le process s'arrête sur une
  // trace au lieu d'un message.
  const failure = new Promise((_, reject) => stream.on('error', reject));
  await Promise.race([
    exportOrdersCsv({ out: stream, filter, includeHeader: true }),
    failure
  ]);
  // Attendre la fermeture : sortir avant le vidage du tampon tronquerait le CSV.
  await Promise.race([
    new Promise((resolve) => { stream.on('finish', resolve); stream.end(); }),
    failure
  ]);
  const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean).length;
  console.log(`OK: ${Math.max(0, lines - 1)} ligne(s) exportée(s) -> ${outPath}`);
  await mongoose.disconnect();
}
} catch (err) {
  console.error(`❌ Écriture impossible : ${err?.message || err}`);
  if (err?.code === 'EACCES' || err?.code === 'ENOENT') {
    console.error('   Vérifiez le chemin de --out. Un nom de fichier seul est écrit dans data/outputs/ ;');
    console.error('   un chemin est pris tel quel, relatif au dossier courant.');
  }
  try { await mongoose.disconnect(); } catch { /* rien de mieux à faire */ }
  process.exit(1);
}
