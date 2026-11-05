/**
 * Ouvre ou ferme les portes de vente d'une saison, et son état de publication.
 *
 * Pendant de scripts/04-event-management/publish-event.js, à ceci près qu'une
 * saison n'a pas UNE porte mais plusieurs : on ferme couramment le
 * renouvellement pendant que la vente publique tourne. Chaque porte a donc son
 * état, et on ne pilote que celles qu'on nomme.
 *
 *   activity  : draft -> active -> archived
 *   renew     : notopen -> open -> closed      (/season/<code>/renew)
 *   subscribe : notopen -> open -> closed      (/season/<code>/subscribe)
 *
 * Usage:
 *   node scripts/03-season-management/publish-season.js --season=2025-2026 --activity=active --renew=open
 *   node scripts/03-season-management/publish-season.js --season=2025-2026 --renew=closed --subscribe=open
 *   node scripts/03-season-management/publish-season.js --season=2025-2026 --show
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 *   - MONGODB_DB (optionnel)
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { Season } from '../../src/models/Season.js';
import { ACTIVITY_STATES, DOOR_STATES, SEASON_DOORS } from '../../src/utils/season-sale.js';

import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('season', { type: 'string', demandOption: true, desc: 'Code saison' })
    .option('activity', { type: 'string', choices: ACTIVITY_STATES, desc: `État de publication (${ACTIVITY_STATES.join('|')})` })
    .option('renew', { type: 'string', choices: DOOR_STATES, desc: `Renouvellement (${DOOR_STATES.join('|')})` })
    .option('subscribe', { type: 'string', choices: DOOR_STATES, desc: `Abonnement public (${DOOR_STATES.join('|')})` })
    .option('show', { type: 'boolean', default: false, desc: 'Affiche l\'état courant sans rien changer' })
    .help().argv;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  const opts = {};
  if (process.env.MONGODB_DB) opts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, opts);

  const season = await Season.findOne({ $or: [{ code: argv.season }, { seasonCode: argv.season }] });
  if (!season) throw new Error(`Saison introuvable : ${argv.season}`);

  const describe = (s) => [
    `activity=${s.activity || 'draft'}`,
    ...SEASON_DOORS.map(d => `${d}=${s[d] || 'notopen'}`)
  ].join(' , ');

  if (argv.show) {
    console.log(`${season.code} — ${describe(season)}`);
    // La porte ouverte ne suffit pas : une saison en brouillon reste fermée.
    if ((season.activity || 'draft') !== 'active') {
      console.log('⚠ activity != active : toutes les portes restent fermées au public.');
    }
    await mongoose.disconnect();
    return;
  }

  const update = {};
  if (argv.activity !== undefined) update.activity = argv.activity;
  for (const door of SEASON_DOORS) {
    if (argv[door] !== undefined) update[door] = argv[door];
  }
  if (!Object.keys(update).length) {
    throw new Error(`Précisez au moins --activity, ${SEASON_DOORS.map(d => `--${d}`).join(' ou ')} (ou --show)`);
  }

  const before = describe(season);
  Object.assign(season, update);
  await season.save();
  console.log(`✅ ${season.code}`);
  console.log(`   avant : ${before}`);
  console.log(`   après : ${describe(season)}`);

  if ((season.activity || 'draft') !== 'active'
      && SEASON_DOORS.some(d => season[d] === 'open')) {
    // Erreur de manipulation la plus probable : ouvrir une porte et oublier
    // de publier la saison. Rien ne serait visible, sans rien pour le dire.
    console.warn('⚠ Une porte est ouverte mais activity != active : rien n\'est accessible. Ajoutez --activity=active.');
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
