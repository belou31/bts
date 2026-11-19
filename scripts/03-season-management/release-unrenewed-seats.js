/**
 * Libère les sièges provisionnés qu'un abonné n'a pas renouvelés.
 *
 * Reprend la seule moitié utile de l'ancien `renewal-close-phase.js` : celui-ci
 * écrivait aussi `Season.enableRenewal = false`, un drapeau que rien ne lisait.
 * Fermer le renouvellement est désormais le travail de `publish-season.js`
 * (`--renew=closed`), et rendre les sièges au public celui de ce script.
 *
 * Les deux restent séparés à dessein : on ferme souvent le renouvellement
 * avant de libérer les sièges (le temps de relancer les retardataires par
 * téléphone), et libérer trop tôt donne leur place à quelqu'un d'autre.
 *
 * Un siège n'est libéré que s'il est encore `provisioned` : un siège déjà
 * renouvelé est passé à `booked` et n'est jamais touché ici.
 *
 * Usage:
 *   node scripts/03-season-management/release-unrenewed-seats.js <seasonCode> [--venue=<slug>] [--dry-run]
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Seat, Season } from '../../src/models/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function arg(name, def = null) {
  const p = process.argv.find(a => a.startsWith(`--${name}=`));
  return p ? p.split('=').slice(1).join('=') : def;
}
const hasFlag = name => process.argv.includes(`--${name}`);

async function main() {
  const seasonCode = process.argv[2];
  if (!seasonCode || seasonCode.startsWith('--')) {
    console.error('Usage: node scripts/03-season-management/release-unrenewed-seats.js <seasonCode> [--venue=<slug>] [--dry-run]');
    process.exit(1);
  }
  const venueSlug = arg('venue', null);
  const dryRun = hasFlag('dry-run');

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  await mongoose.connect(uri, {});

  const season = await Season.findOne({ code: seasonCode }).lean();
  if (!season) throw new Error(`Saison introuvable : ${seasonCode}`);

  // Libérer pendant que le renouvellement tourne encore reprendrait leur siège
  // à des abonnés toujours en train de le confirmer.
  if ((season.renew || 'notopen') === 'open') {
    console.warn(`⚠ ${seasonCode} : renew=open — des abonnés peuvent encore renouveler.`);
    console.warn('  Fermez d\'abord : publish-season.js --season=' + seasonCode + ' --renew=closed');
  }

  const filter = { seasonCode, status: 'provisioned' };
  if (venueSlug) filter.venueSlug = venueSlug;

  const count = await Seat.countDocuments(filter);
  if (dryRun) {
    console.log(`[dry-run] ${count} siège(s) seraient libérés (${seasonCode}${venueSlug ? ` / ${venueSlug}` : ''}).`);
    await mongoose.disconnect();
    return;
  }

  const res = await Seat.updateMany(filter, { $set: { status: 'available', provisionedFor: null } });
  console.log(`✅ ${seasonCode}${venueSlug ? ` / ${venueSlug}` : ''} — ${res.modifiedCount} siège(s) libéré(s) sur ${count} provisionné(s).`);

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
