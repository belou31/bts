/**
 * Rend UNIQUE l'index SeatHold {eventId, seatId}.
 *
 * Le schéma (src/models/SeatHold.js) le déclare unique depuis toujours, mais
 * Mongoose ne modifie jamais les options d'un index déjà créé : une base où
 * l'index existait avant l'ajout du flag garde un index NON unique, en
 * silence. Conséquence concrète : le verrou de siège d'un évènement ne
 * verrouille rien — deux acheteurs peuvent poser un hold sur la même place et
 * payer tous les deux (voir claimEventSeatHolds dans event-flow.factory.js).
 *
 * L'index unique refusant de se construire s'il reste des doublons, on purge
 * d'abord : pour un même (eventId, seatId) on garde le hold le plus ancien.
 *
 * Usage:
 *   node scripts/migrations/migrate-seathold-unique-event-seat.js           # dry-run
 *   node scripts/migrations/migrate-seathold-unique-event-seat.js --apply
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { SeatHold } from '../../src/models/SeatHold.js';

import dotenv from 'dotenv';
dotenv.config();

const INDEX_NAME = 'idx_event_seat';

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('apply', { type: 'boolean', default: false, desc: 'Write changes (default: dry-run)' })
    .help().argv;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  const before = await SeatHold.collection.indexes();
  const existing = before.find(i => i.name === INDEX_NAME);
  console.log(`Index ${INDEX_NAME}: ${existing ? (existing.unique ? 'déjà UNIQUE' : 'présent mais NON unique') : 'absent'}`);

  // Doublons éventuels : un hold par (eventId, seatId), le plus ancien gagne.
  const dupes = await SeatHold.aggregate([
    { $group: { _id: { eventId: '$eventId', seatId: '$seatId' }, ids: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } }
  ]);
  let removed = 0;
  for (const group of dupes) {
    const ids = group.ids.slice(1); // garde le premier (ordre d'insertion)
    removed += ids.length;
    console.log(`${argv.apply ? '✅' : '·'} ${group._id.seatId} (event ${group._id.eventId}) : ${ids.length} hold(s) en trop`);
    if (argv.apply) await SeatHold.deleteMany({ _id: { $in: ids } });
  }
  console.log(`${removed} hold(s) en double ${argv.apply ? 'supprimé(s)' : 'à supprimer'}.`);

  if (existing?.unique) {
    console.log('Rien à faire : l’index est déjà unique.');
  } else if (argv.apply) {
    if (existing) {
      await SeatHold.collection.dropIndex(INDEX_NAME);
      console.log(`Index ${INDEX_NAME} supprimé.`);
    }
    await SeatHold.collection.createIndex({ eventId: 1, seatId: 1 }, { unique: true, name: INDEX_NAME });
    console.log(`Index ${INDEX_NAME} recréé en UNIQUE.`);
  } else {
    console.log(`Dry-run : l’index ${INDEX_NAME} serait recréé en UNIQUE.`);
  }

  if (argv.apply) {
    const after = await SeatHold.collection.indexes();
    const now = after.find(i => i.name === INDEX_NAME);
    console.log(`Vérification : ${INDEX_NAME} unique = ${Boolean(now?.unique)}`);
  } else {
    console.log('\nDry-run uniquement — relancer avec --apply pour écrire.');
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
