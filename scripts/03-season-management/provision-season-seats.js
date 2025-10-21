/**
 * Provision seats according to business rules.
 *
 * Sets seat status to "busy" for predefined categories (VIP, SPECIALE, VISITORS, FANCLUB, UNAVAILABLE).
 * Runs in dry-run mode by default; add --apply to persist changes.
 *
 * Usage:
 *   node scripts/03-season-management/provision-season-seats.js
 *   node scripts/03-season-management/provision-season-seats.js --apply
 *
 * Environment:
 *   - MONGO_URI (required)
 *   - MONGODB_DB (optional database name)
 *   - SEASON / VENUE (optional overrides; defaults to active season)
 *
 * Template:
 *
 * Rules:
 *   VIP        → zone S4
 *   SPECIALE   → zones S3 & S4A
 *   VISITORS   → zone S2 rows D–G
 *   FANCLUB    → zones N5/N6/N7 rows L–N
 *   UNAVAILABLE→ listed individual seats (visibility constraints)
 */

import mongoose from 'mongoose';

import dotenv from 'dotenv';
dotenv.config();

// ⚠️ adapte les chemins d'import à ton repo si besoin
import { Seat }   from '../../src/models/Seat.js';
import { Season } from '../../src/models/Season.js';

// -------- Connexion Mongo (INT/PROD avec auth) ----------
function arg(k) {
  const p = `--${k}=`;
  const v = process.argv.find(a => a.startsWith(p));
  return v ? v.slice(p.length) : null;
}

const uri = process.env.MONGO_URI ;

// petit helper logs
const log = (...a) => console.log('[provision-season]', ...a);

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
  const visitorsFilter = { ...base, seatId: { $regex: /^(?:S2)-(?:D|E|F|G)-\d+$/ } };

  // --- Règle FANCLUB (TBH7): zones N5,N6,N7, rangées L,M,N ---
  const fanclubFilter = { ...base, seatId: { $regex: /^(?:N5|N6|N6B)-(?:L|M)-\d+$/ } };

  // --- Règle fanclubFilter2: sièges unitaires
  const fanclub2List = [
    'N7-L-084', 'N7-L-085', 'N7-L-086', 'N7-L-087', 'N7-L-088',
    'N7-M-101', 'N7-M-102', 'N7-M-103', 'N7-M-104', 'N7-M-105',
    'N7-N-013', 'N7-N-014', 'N7-N-015', 'N7-N-016', 'N7-N-017', 'N7-N-018', 'N7-N-019', 'N7-N-020', 'N7-N-021', 'N7-N-022', 'N7-N-023','N7-N-024'
  ];
  const fanclub2Filter = {
    ...base,
    $or: fanclub2List.map(id => ({ seatId: { $regex: patternForId(id) } }))
  };

  // --- Règle tisseoClubeoFilter: sièges unitaires
  const tisseoClubeoList = [
    'N7-L-089', 'N7-L-089', 'N7-L-089', 'N7-L-089', 'N7-L-089', 'N7-L-089', 'N7-L-089', 'N7-L-089', 'N7-L-089', 'N7-L-089', 'N7-L-089', 'N7-L-089', 'N7-L-101',
    'N7-M-106', 'N7-M-107', 'N7-M-108', 'N7-M-109', 'N7-M-110', 'N7-M-111', 'N7-M-112', 'N7-M-113', 'N7-M-114', 'N7-M-115', 'N7-M-116', 'N7-M-117', 'N7-M-118'
  ];
  const tisseoClubeoFilter = {
    ...base,
    $or: tisseoClubeoList.map(id => ({ seatId: { $regex: patternForId(id) } }))
  };



  // --- Règle UNAVAILABLE: sièges unitaires
  const unavailableList = [
    // Siège manquant
    'S2-F-013',
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
  await applyCategory('FANCLUB TBH7 2 (sièges en N7)', fanclub2Filter);
  await applyCategory('TISSEO CLUBEO (sièges en N7)', tisseoClubeoFilter);
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

  
