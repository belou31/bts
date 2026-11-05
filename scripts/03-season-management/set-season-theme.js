#!/usr/bin/env node
/**
 * Sets (or clears) a season's explicit templateTheme override — same
 * contract as scripts/04-event-management/set-event-theme.js, but for
 * subscription/public orders that aren't tied to one event. See
 * Event.templateTheme's comment in src/models/Event.js for the full
 * resolution priority.
 *
 * Usage:
 *   node scripts/03-season-management/set-season-theme.js --season=<code> --theme=<value> [--dry-run]
 *   node scripts/03-season-management/set-season-theme.js --season=<code> --clear [--dry-run]
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { Season } from '../../src/models/Season.js';

const argv = yargs(hideBin(process.argv))
  .option('season', { type: 'string', demandOption: true, desc: 'Code saison' })
  .option('theme', { type: 'string', desc: 'Valeur du thème (ex: ads, halloween)' })
  .option('clear', { type: 'boolean', default: false, desc: 'Efface le thème (retombe sur le système de customization)' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Aperçu sans écriture' })
  .help()
  .argv;

async function main() {
  if (!argv.clear && !argv.theme) throw new Error('--theme=<value> ou --clear requis');

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI/MONGODB_URI manquant');
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  const seasonCode = String(argv.season).trim();
  const season = await Season.findOne({ code: seasonCode }).lean();
  if (!season) throw new Error(`Saison introuvable: ${seasonCode}`);

  const nextTheme = argv.clear ? null : String(argv.theme).trim();
  console.log(`→ Saison: ${seasonCode} · templateTheme actuel="${season.templateTheme || '∅'}" → nouveau="${nextTheme || '∅'}"`);

  if (argv['dry-run']) {
    console.log('\n🧪 Dry-run — rien n\'est écrit.');
    await mongoose.disconnect();
    return;
  }

  await Season.updateOne({ code: seasonCode }, { $set: { templateTheme: nextTheme } });
  console.log(`\n✅ templateTheme mis à jour pour "${seasonCode}".`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message || e);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
