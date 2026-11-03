#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { connectMongo, readCsv, logDryRun } from '../_utils.js';
import { compileSeatPattern, explainNoMatch } from '../lib/seat-pattern.js';
import { SeatHold } from '../../src/models/SeatHold.js';
import { Event } from '../../src/models/Event.js';
import { Seat } from '../../src/models/Seat.js';

const argv = yargs(hideBin(process.argv))
  .option('event', { type: 'string', demandOption: true, desc: 'Slug ou ID de l\'événement' })
  .option('file',  { type: 'string', demandOption: true })
  .option('force', { type: 'boolean', default: false, desc: 'forcer le blocage/libération' })
  .option('commit',{ type: 'boolean', default: false })
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

(async () => {
  await connectMongo();
  logDryRun(argv.commit);

  const eventKey = String(argv.event || '').trim();
  if (!eventKey) {
    console.error('❌ Paramètre --event requis (slug ou ObjectId)');
    process.exit(1);
  }

  let eventDoc;
  if (/^[0-9a-fA-F]{24}$/.test(eventKey)) {
    eventDoc = await Event.findById(eventKey).select({ _id: 1, seasonCode: 1, venueSlug: 1 }).lean();
  } else {
    eventDoc = await Event.findOne({ slug: eventKey }).select({ _id: 1, seasonCode: 1, venueSlug: 1 }).lean();
  }
  if (!eventDoc?._id) {
    console.error(`❌ Événement introuvable pour "${eventKey}"`);
    process.exit(1);
  }
  const eventId = eventDoc._id.toString();
  const seasonCode = eventDoc.seasonCode;
  const venueSlug = eventDoc.venueSlug;

  const rows = await readCsv(argv.file);
  let blocked = 0, freed = 0;
  let holdUpserts = 0, holdDeletes = 0;

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
      const docBase = {
        seasonCode,
        venueSlug,
        reason,
        expiresAt,
        forced: !!argv.force,
        ...(zoneKey ? { zoneKey } : {})
      };
      if (!argv.commit) {
        console.log('🧪 BLOCK', { hold: { ...docBase, eventId, seatId: seatId || seatPattern }, seats: seatFilter });
        blocked++;
        continue;
      }

      if (seatsToTarget.length) {
        for (const seat of seatsToTarget) {
          const q = { eventId, seatId: seat.seatId };
          const doc = { ...docBase, ...q };
          await SeatHold.findOneAndUpdate(q, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
          holdUpserts++;
        }
      } else {
        const q = { eventId, ...(zoneKey ? { zoneKey } : {}) };
        const doc = { ...docBase, ...q };
        await SeatHold.findOneAndUpdate(q, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
        holdUpserts++;
      }
      blocked++;
      // Rien de plus à écrire : ce script bloque POUR UN MATCH, donc
      // uniquement via SeatHold (eventId, ci-dessus) — jamais Seat.status,
      // qui vaut pour la SAISON entière et vaudrait pour tous les autres
      // matchs. C'est exactement ce que fait admin/plan (src/routes/admin/
      // seat-state.routes.js) pour un blocage scope "event" ; block-free-
      // seats-for-SEASON.js reste le seul endroit qui touche Seat.status.
    } else if (action === 'free') {
      const holdDeletionFilter = (() => {
        if (seatsToTarget.length) {
          return {
            eventId,
            ...(zoneKey ? { zoneKey } : {}),
            seatId: { $in: seatsToTarget.map(s => s.seatId) }
          };
        }
        if (seatId) return { eventId, seatId, ...(zoneKey ? { zoneKey } : {}) };
        if (zoneKey) return { eventId, zoneKey };
        return { eventId };
      })();

      if (!argv.commit) {
        console.log('🧪 FREE', { hold: holdDeletionFilter, seats: seatFilter });
        freed++;
        continue;
      }

      const delRes = await SeatHold.deleteMany(holdDeletionFilter);
      freed++;
      holdDeletes += Number(delRes.deletedCount || 0);
      // Même raison que pour "block" : libérer ici ne doit défaire QUE le
      // SeatHold de CET évènement. L'ancien code remettait aussi Seat.status
      // à 'available' sans filtrer par eventId — donc au niveau de la SAISON
      // entière, rendant la place disponible pour TOUS les matchs d'un coup.
    } else {
      console.warn('⏭️  action inconnue:', action);
    }
  }

  console.log(`✅ Blocked: ${blocked} | Freed: ${freed}`);
  if (argv.commit) {
    console.log(`ℹ️ SeatHold upserts=${holdUpserts} deletes=${holdDeletes}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
