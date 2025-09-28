// scripts/provision-seats.js
// Provisionne (status = 'busy') des ensembles de sièges selon règles métier.
// Par défaut DRY-RUN (aucune écriture). Ajouter --apply pour écrire.
//
// ENV attendues :
//   MONGO_URI (ex: mongodb://127.0.0.1:27017/bts)
//   MONGODB_DB  (ex: bts)
//   SEASON      (facultatif; sinon saison active)
//   VENUE       (facultatif; sinon venue de la saison active)
//
// Règles implémentées (hors RENEW) :
//   VIP        : toutes les places en zone S4
//   SPECIALE   : toutes les places en S3 et S4A
//   VISITORS   : toutes les places rangées F,G de la zone S2
//   FANCLUB    : rangées L,M,N des zones N5,N6,N7
//   UNAVAILABLE: S2-F-013 et les 12 sièges à visibilité réduite
//
// Exécution :
//   node scripts/provision-seats.js           # dry-run (affiche ce qui serait fait)
//   node scripts/provision-seats.js --apply   # écrit en base
//
// Vérification : voir la section “Vérifier” à la fin.

import mongoose from 'mongoose';

import dotenv from 'dotenv';
dotenv.config();

// ⚠️ adapte les chemins d'import à ton repo si besoin
import { Seat }   from '../src/models/Seat.js';
import { Season } from '../src/models/Season.js';

// -------- Connexion Mongo (INT/PROD avec auth) ----------
function arg(k) {
  const p = `--${k}=`;
  const v = process.argv.find(a => a.startsWith(p));
  return v ? v.slice(p.length) : null;
}

const uri = process.env.MONGO_URI ;

// petit helper logs
const log = (...a) => console.log('[provision]', ...a);

function isApply() {
  return process.argv.includes('--apply') || String(process.env.APPLY || '').toLowerCase() === 'yes';
}

// Récupère (seasonCode, venueSlug)
// - via ENV SEASON/VENUE
// - sinon via saison "active" (isActive: true ou active: true)
async function resolveSeasonVenue() {
  if (process.env.SEASON && process.env.VENUE) {
    return { seasonCode: process.env.SEASON, venueSlug: process.env.VENUE };
  }
  const s = await Season.findOne({ $or: [{ isActive: true }, { active: true }] }).lean();
  if (!s) throw new Error('Aucune saison active et SEASON/VENUE non fournis.');
  const seasonCode = s.code || s.seasonCode;
  const venueSlug  = s.venueSlug || s.venue;
  if (!seasonCode || !venueSlug) throw new Error('Saison active incomplète (code/venue manquants).');
  return { seasonCode, venueSlug };
}

// Construit un RegExp qui matche un seatId où la dernière partie numérique accepte 0..n zéros en tête.
// ex: patternForId('S5-F-048') => /^S5-F-0*48$/  (matche S5-F-048, S5-F-48)
function patternForId(id) {
  const s = String(id || '');
  const parts = s.split('-');
  const last = parts.pop() || '';
  if (!/^\d+$/.test(last)) return new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
  const prefix = parts.join('-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const num = String(parseInt(last, 10)); // dépouille les zéros en tête
  return new RegExp(`^${prefix}-0*${num}$`);
}

async function main() {
  const APPLY = isApply();

  try {
    const opts = {};
    await mongoose.connect(uri, opts);
  } catch (e) {
    console.error('[provision] Mongo connect failed:', e?.message || e);
    if (/requires authentication|auth/i.test(String(e?.message || ''))) {
      console.error('[provision] Conseil: fournissez une URI authentifiée, ex.:');
      console.error("  MONGO_URI='mongodb://bts:***@127.0.0.1:27017/bts?authSource=bts'");
      console.error('  ou utilisez --uri=...  (le mot de passe doit être URL-encodé)');
    }
    process.exit(1);
  }

  const { seasonCode, venueSlug } = await resolveSeasonVenue();

  log(`Target season=${seasonCode} venue=${venueSlug}`);

  // Base filter commun
  const base = { seasonCode, venueSlug, status: { $ne: 'booked' } };

  // --- Règle VIP: zone S4 ---
  const vipFilter = { ...base, zoneKey: 'S4' };

  // --- Règle SPECIALE: zones S3 et S4A ---
  const specialeFilter = { ...base, zoneKey: { $in: ['S3', 'S4A'] } };

  // --- Règle VISITORS: zone S2, rangées F ou G (seatId "S2-F-XXX" / "S2-G-XXX") ---
  const visitorsFilter = { ...base, seatId: { $regex: /^(?:S2)-(?:F|G)-\d+$/ } };

  // --- Règle FANCLUB (TBH7): zones N5,N6,N7, rangées L,M,N ---
  const fanclubFilter = { ...base, seatId: { $regex: /^(?:N5|N6|N7)-(?:L|M|N)-\d+$/ } };
  //const fanclubFilter2 = { ...base, seatId: { $regex: /N6-K-\d+$/ } };

  // --- Règle UNAVAILABLE: sièges unitaires
  const unavailableList = [
    // Siège manquant
    'S2-F-013',
    // Correctif rapide
    'S5-C-064', 'S5-C-065', 'S5-C-066',
    'N4B-M-063', 'N4B-M-064', 'N4B-M-065', 'N4B-M-066', 'N4B-M-067', 'N4B-M-068', 'N4B-M-069',
    'N4-H-033','N4-H-035','N4-H-036','N4-H-037','N4-H-042','N4-H-043','N4-H-044','N4-H-045',
    // Manque de visibilité (12 sièges)
    'S5-E-042', 'S5-E-043', 'S5-E-044', 'S5-E-045',
    'S5-F-048', 'S5-F-049', 'S5-F-050',
    'S6-E-046', 'S6-E-047',
    'S6-F-051', 'S6-F-052', 'S6-F-053'
  ];
  // Accepte formes paddées / non paddées
  const unavailableFilter = {
    ...base,
    $or: unavailableList.map(id => ({ seatId: { $regex: patternForId(id) } }))
  };

  // Helper qui fait un find+count et un updateMany optionnel
  async function applyCategory(name, filter) {
    const sample = await Seat.find(filter, { _id: 0, seatId: 1 }).limit(10).lean();
    const count = await Seat.countDocuments(filter);
    log(`${name}: matches=${count}`, sample.length ? `sample=[${sample.map(s => s.seatId).join(', ')}]` : '');
    if (APPLY && count > 0) {
      const r = await Seat.updateMany(filter, { $set: { status: 'busy' } }, { runValidators: false });
      log(`${name}: updated matched=${r.matchedCount ?? r.n ?? 0}, modified=${r.modifiedCount ?? r.nModified ?? 0}`);
    }
  }

  // Exécution des catégories (ordre non bloquant, elles posent toutes 'busy')
  await applyCategory('VIP (zone S4)', vipFilter);
  await applyCategory('SPECIALE (zones S3,S4A)', specialeFilter);
  await applyCategory('VISITORS (S2 rangées F,G)', visitorsFilter);
  await applyCategory('FANCLUB TBH7 (N5/N6/N7 rangées L,M,N)', fanclubFilter);
  //await applyCategory('FANCLUB TBH7 2 N6 rangée K', fanclubFilter2);
  await applyCategory('UNAVAILABLE (sièges unitaires)', unavailableFilter);

  if (!APPLY) {
    log('Dry-run terminé. Relance avec --apply pour écrire.');
  }

  await mongoose.disconnect();
}

main()
  .then(() => { log('Done.'); process.exit(0); })
  .catch(err => {
    console.error('[provision] ERROR:', err?.message || err);
    if (/requires authentication|auth/i.test(String(err?.message || ''))) {
      console.error('[provision] URI actuelle:', maskUri(uri));
    }
    process.exit(1);
  });

  