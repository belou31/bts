#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { connectMongo, readCsv, logDryRun } from '../_utils.js';
import { compileSeatPattern, explainNoMatch } from '../lib/seat-pattern.js';
import { Season } from '../../src/models/Season.js';
import { Seat } from '../../src/models/Seat.js';

const argv = yargs(hideBin(process.argv))
  .option('file',   { type: 'string', demandOption: true })
  .option('season', { type: 'string', desc: 'Code saison (sinon saison active)' })
  .option('venue',  { type: 'string', desc: 'Slug du lieu (sinon saison active)' })
  .option('force',  { type: 'boolean', default: false, desc: 'forcer le blocage/libération' })
  .option('commit', { type: 'boolean', default: false })
  .argv;

function patternForId(id) {
  const s = String(id || '');
  const parts = s.split('-');
  const last = parts.pop() || '';
  if (!/^\d+$/.test(last)) return new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  const prefix = parts.join('-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const num = String(parseInt(last, 10));
  return new RegExp(`^${prefix}-0*${num}$`, 'i');
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function resolveSeasonVenue() {
  const seasonCode = argv.season || process.env.SEASON;
  const venueSlug  = argv.venue  || process.env.VENUE;
  if (seasonCode && venueSlug) return { seasonCode, venueSlug };

  const s = await Season.findOne({ $or: [{ isActive: true }, { active: true }] })
    .select({ code: 1, seasonCode: 1, venueSlug: 1, venue: 1 })
    .lean();
  if (!s) throw new Error('Aucune saison active et SEASON/VENUE non fournis.');
  const resolvedSeason = s.code || s.seasonCode;
  const resolvedVenue  = s.venueSlug || s.venue;
  if (!resolvedSeason || !resolvedVenue) {
    throw new Error('Saison active incomplète (code/venue manquants).');
  }
  return { seasonCode: resolvedSeason, venueSlug: resolvedVenue };
}

(async () => {
  await connectMongo();
  logDryRun(argv.commit);

  const { seasonCode, venueSlug } = await resolveSeasonVenue();
  console.log(`Target season=${seasonCode} venue=${venueSlug}`);

  const rows = await readCsv(argv.file);
  let blocked = 0, freed = 0;
  let seatsHeld = 0, seatsFreed = 0;

  for (const r of rows) {
    const action = (r.action || '').toLowerCase(); // block | free
    const zoneKey = r.zoneKey ? String(r.zoneKey).trim().toUpperCase() : null;
    const seatId = r.seatId ? String(r.seatId).trim() : null;
    const seatPattern = r.seatPattern ? String(r.seatPattern).trim() : null;
    const reason = r.reason ? String(r.reason) : '';
    const expiresAt = parseDate(r.expiresAt);

    const seatIdRegex = seatPattern ? compileSeatPattern(seatPattern) : (seatId ? patternForId(seatId) : null);
    if (seatPattern && !seatIdRegex) continue;

    if (!seatIdRegex && !zoneKey) {
      console.warn('⏭️  ligne sans seatId/seatPattern ni zoneKey, ignorée');
      continue;
    }

    const seatFilter = {
      seasonCode,
      venueSlug,
      ...(seatIdRegex ? { seatId: { $regex: seatIdRegex } } : {}),
      ...(zoneKey ? { zoneKey } : {})
    };

    const seatsToTarget = seatPattern
      ? await Seat.find(seatFilter, { _id: 0, seatId: 1 }).lean()
      : (seatId ? [{ seatId }] : []);

    if (!seatsToTarget.length && seatPattern) {
      await explainNoMatch({ pattern: seatPattern, Seat, filter: seatFilter });
      continue;
    }

    if (action === 'block') {
      const holdReason = reason || (argv.force ? 'Season block (force)' : 'Season block');
      const seatUpdate = {
        $set: {
          status: 'busy',
          'meta.hold.reason': holdReason
        }
      };
      if (expiresAt) {
        seatUpdate.$set['meta.hold.until'] = expiresAt;
      } else {
        seatUpdate.$unset = { 'meta.hold.until': '' };
      }

      if (!argv.commit) {
        console.log('🧪 BLOCK season', { seats: seatFilter, reason: holdReason, expiresAt });
        blocked++;
        continue;
      }

      const blockFilter = { ...seatFilter };
      if (!argv.force) {
        blockFilter.status = { $in: ['available', 'held'] };
      }

      const res = await Seat.updateMany(blockFilter, seatUpdate);
      blocked++;
      const modified = Number(res.modifiedCount || 0);
      seatsHeld += modified;
      if (modified === 0) {
        console.warn('⚠️  Aucun siège mis à jour pour ce blocage (déjà réservé ou introuvable).');
      }
    } else if (action === 'free') {
      const seatUpdate = {
        $set: { status: 'available' },
        $unset: { 'meta.hold': '' }
      };
      const freeFilter = { ...seatFilter };
      if (!argv.force) {
        freeFilter.status = { $in: ['busy', 'held'] };
      }

      if (!argv.commit) {
        console.log('🧪 FREE season', { seats: freeFilter });
        freed++;
        continue;
      }

      const res = await Seat.updateMany(freeFilter, seatUpdate);
      freed++;
      const modified = Number(res.modifiedCount || 0);
      seatsFreed += modified;
      if (modified === 0) {
        console.warn('⚠️  Aucun siège mis à jour pour cette libération (peut-être déjà disponible).');
      }
    } else {
      console.warn('⏭️  action inconnue:', action);
    }
  }

  console.log(`✅ Blocked: ${blocked} | Freed: ${freed}`);
  if (argv.commit) {
    console.log(`ℹ️ Seats mis à jour → held: ${seatsHeld}, freed: ${seatsFreed}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
