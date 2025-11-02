#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { connectMongo, readCsv, logDryRun } from '../_utils.js';
import { SeatHold } from '../../src/models/SeatHold.js';
import { Event } from '../../src/models/Event.js';
import { Seat } from '../../src/models/Seat.js';

const argv = yargs(hideBin(process.argv))
  .option('event', { type: 'string', demandOption: true, desc: 'Slug ou ID de l\'événement' })
  .option('file',  { type: 'string', demandOption: true })
  .option('force', { type: 'boolean', default: false, desc: 'forcer le blocage/libération' })
  .option('commit',{ type: 'boolean', default: false })
  .argv;

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
  let seatsHeld = 0, seatsFreedCount = 0;
  let holdUpserts = 0, holdDeletes = 0;

  for (const r of rows) {
    const action = (r.action || '').toLowerCase(); // block | free
    const zoneKey = r.zoneKey ? String(r.zoneKey).trim().toUpperCase() : null;
    const seatId = r.seatId ? String(r.seatId).trim() : null;

    if (!seatId && !zoneKey) {
      console.warn('⏭️  ligne sans seatId ni zoneKey, ignorée');
      continue;
    }

    const q = {
      eventId,
      ...(seatId ? { seatId } : {}),
      ...(zoneKey ? { zoneKey } : {})
    };

    const seatFilter = {
      seasonCode,
      venueSlug,
      ...(seatId ? { seatId } : {}),
      ...(zoneKey ? { zoneKey } : {})
    };

    if (action === 'block') {
      const doc = {
        ...q,
        seasonCode,
        venueSlug,
        reason: r.reason ? String(r.reason) : '',
        expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
        forced: !!argv.force,
      };
      if (!argv.commit) {
        console.log('🧪 BLOCK', { hold: doc, seats: seatFilter });
        continue;
      }
      // si --force, on remplace les holds existants sinon on upsert si absent
      await SeatHold.findOneAndUpdate(q, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
      blocked++;
      holdUpserts++;

      const holdReason = doc.reason || (argv.force ? 'Admin hold (force)' : 'Admin hold');
      const seatUpdate = {
        $set: {
          status: 'held',
          'meta.hold.reason': holdReason
        }
      };
      if (doc.expiresAt) {
        seatUpdate.$set['meta.hold.until'] = doc.expiresAt;
      } else {
        seatUpdate.$unset = { 'meta.hold.until': '' };
      }

      const blockFilter = { ...seatFilter };
      if (!argv.force) {
        blockFilter.status = { $in: ['available', 'held'] };
      }
      const res = seatId
        ? await Seat.updateOne(blockFilter, seatUpdate)
        : await Seat.updateMany(blockFilter, seatUpdate);
      const modified = Number(res.modifiedCount || 0);
      seatsHeld += modified;
      if (modified === 0) {
        console.warn('⚠️  Aucun siège mis à jour pour ce blocage (déjà réservé ou introuvable).');
      }
    } else if (action === 'free') {
      if (!argv.commit) {
        console.log('🧪 FREE', { hold: q, seats: seatFilter });
        continue;
      }
      // si --force on supprime même si expiré/non-expiré; sinon suppression standard
      const delRes = await SeatHold.deleteMany(q);
      freed++;
      holdDeletes += Number(delRes.deletedCount || 0);

      const seatUpdate = {
        $set: { status: 'available' },
        $unset: { 'meta.hold': '' }
      };
      const freeFilter = { ...seatFilter };
      if (!argv.force) {
        freeFilter.status = 'held';
      }

      const res = seatId
        ? await Seat.updateOne(freeFilter, seatUpdate)
        : await Seat.updateMany(freeFilter, seatUpdate);
      const modified = Number(res.modifiedCount || 0);
      seatsFreedCount += modified;
      if (modified === 0) {
        console.warn('⚠️  Aucun siège mis à jour pour cette libération (peut-être déjà disponible).');
      }
    } else {
      console.warn('⏭️  action inconnue:', action);
    }
  }

  console.log(`✅ Blocked: ${blocked} | Freed: ${freed}`);
  if (argv.commit) {
    console.log(`ℹ️ SeatHold upserts=${holdUpserts} deletes=${holdDeletes}`);
    console.log(`ℹ️ Seats mis à jour → held: ${seatsHeld}, freed: ${seatsFreedCount}`);
  }
  if (argv.commit) {
    console.log(`ℹ️ Seats mis à jour → held: ${seatsHeld}, freed: ${seatsFreedCount}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
