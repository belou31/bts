/**
 * Crée / met à jour les index de TOUS les modèles.
 *
 * À exécuter après chaque déploiement, et OBLIGATOIREMENT après un
 * reset-db.js sur INT ou PROD.
 *
 * Pourquoi ce n'est pas automatique hors développement : src/loaders/mongoose.js
 * connecte avec `autoIndex: APP_ENV === 'development'`. Sur INT/PROD, Mongoose
 * ne crée donc AUCUN index de lui-même — une base fraîchement recréée tourne
 * sans une seule contrainte d'unicité, et les doublons passent en silence
 * (prix en double, deux commandes payées pour la même place, deux verrous sur
 * le même siège…). Rien ne le signale : l'application fonctionne, elle ne
 * protège simplement plus rien.
 *
 * `syncIndexes()` fait les deux choses utiles : il crée ce qui manque, et il
 * recrée ce qui a dérivé du schéma (Mongoose ne modifie jamais un index
 * existant, même si ses options ont changé depuis).
 *
 * Usage:
 *   node scripts/sync-indexes.mjs            # liste ce qui serait fait
 *   node scripts/sync-indexes.mjs --apply
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

import * as models from '../src/models/index.js';
// Non exportés par l'agrégateur au moment d'écrire ceci — importés
// explicitement pour qu'ils ne restent pas sans index.
import { Voucher } from '../src/models/Voucher.js';
import { Ticket } from '../src/models/Ticket.js';
import { ScanLog } from '../src/models/ScanLog.js';
import { QrBankCode } from '../src/models/QrBankCode.js';

dotenv.config();

const apply = process.argv.includes('--apply');

function collectModels() {
  const all = new Map();
  for (const value of [...Object.values(models), Voucher, Ticket, ScanLog, QrBankCode]) {
    if (value?.modelName && typeof value.syncIndexes === 'function') {
      all.set(value.modelName, value);
    }
  }
  return [...all.values()].sort((a, b) => a.modelName.localeCompare(b.modelName));
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  const opts = { autoIndex: false };
  if (process.env.MONGODB_DB) opts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, opts);
  console.log(`[sync-indexes] base "${mongoose.connection.name}" — ${apply ? 'APPLICATION' : 'dry-run'}\n`);

  const list = collectModels();
  let created = 0;
  let dropped = 0;

  for (const model of list) {
    const wanted = model.schema.indexes();
    let existing = [];
    try {
      existing = await model.collection.indexes();
    } catch {
      existing = []; // collection pas encore créée : normal sur base neuve
    }
    const existingNames = new Set(existing.map(i => i.name).filter(n => n !== '_id_'));
    const missing = wanted.length - existingNames.size;

    if (!apply) {
      console.log(`${model.modelName.padEnd(22)} schéma: ${String(wanted.length).padStart(2)} · en base: ${String(existingNames.size).padStart(2)}${missing > 0 ? '  ← manquant(s)' : ''}`);
      continue;
    }

    const result = await model.syncIndexes().catch(err => {
      console.error(`${model.modelName.padEnd(22)} ❌ ${err.message}`);
      return null;
    });
    if (result === null) continue;

    const after = await model.collection.indexes();
    const afterNames = new Set(after.map(i => i.name).filter(n => n !== '_id_'));
    const droppedHere = Array.isArray(result) ? result.length : 0;
    created += Math.max(0, afterNames.size - existingNames.size);
    dropped += droppedHere;
    console.log(`${model.modelName.padEnd(22)} ✅ ${afterNames.size} index${droppedHere ? ` (${droppedHere} recréé(s))` : ''}`);
  }

  if (apply) {
    console.log(`\n${created} index créé(s), ${dropped} recréé(s) sur ${list.length} modèles.`);
  } else {
    console.log(`\n${list.length} modèles — dry-run, relancer avec --apply pour écrire.`);
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
