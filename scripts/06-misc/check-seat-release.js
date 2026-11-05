// scripts/06-misc/check-seat-release.js
//
// Vérifie qu'annuler une commande rend RÉELLEMENT ses places.
//
// CE QUE CELA PROTÈGE. Deux défauts, tous deux constatés en production après
// le match du 03/10/2026 :
//
//   1. La sentinelle ne supprimait pas les `SeatHold`. Or c'est cette
//      collection que lit le plan de salle : les places d'une commande
//      annulée restaient affichées prises jusqu'à l'expiration du TTL.
//
//   2. Son filtre portait `order._id` (un ObjectId) alors que les trois flux
//      d'achat écrivent `String(order._id)` dans `Seat.meta.hold.orderId`,
//      déclaré `Mixed` — donc non converti par Mongoose. Le filtre ne
//      correspondait à rien : la sentinelle n'a jamais libéré un seul siège.
//      Ses journaux l'affichaient sans que personne le lise : `released: 0`.
//
// Usage : npm run test:seat-release   (mongod local requis)
//
// Base ISOLÉE (bts_releasecheck), créée et supprimée par ce script : il ne
// touche ni la base de développement `bts`, ni la production.
import mongoose from 'mongoose';
import { Order } from '../../src/models/Order.js';
import { Event } from '../../src/models/Event.js';
import { Seat } from '../../src/models/Seat.js';
import { SeatHold } from '../../src/models/SeatHold.js';
import { releaseOrderSeatHolds } from '../../src/services/event-seat-holds.js';
import { computeEventSeatStates, invalidateEventSeatStates } from '../../src/services/event-seat-states.js';

const DB = 'bts_releasecheck';
const SEASON = '2026-2027';
const VENUE = 'releasecheck-arena';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

/** @param {'string'|'objectid'} holdIdForm  comment meta.hold.orderId est écrit */
async function fixture(seatIds, holdIdForm) {
  await Promise.all([
    Order.deleteMany({}), Event.deleteMany({}), Seat.deleteMany({}), SeatHold.deleteMany({})
  ]);
  const ev = await Event.create({
    name: 'Releasecheck', slug: 'releasecheck', seasonCode: SEASON, venueSlug: VENUE,
    startsAt: new Date(Date.now() + 86400000)
  });
  const order = await Order.create({
    eventId: ev._id, seasonCode: SEASON, venueSlug: VENUE, status: 'pending',
    payerEmail: 'releasecheck@example.fr', totalCents: 1100 * seatIds.length,
    origin: { flow: 'event' }, mailTemplateKind: 'event',
    meta: { eventId: String(ev._id) },
    lines: seatIds.map(seatId => ({
      seatId, zoneKey: seatId.split('-')[0], unitType: 'seat',
      zoneType: 'seated', tariffCode: 'NORMAL', priceCents: 1100
    }))
  });
  const holdOrderId = holdIdForm === 'objectid' ? order._id : String(order._id);
  await Seat.insertMany(seatIds.map(seatId => ({
    seasonCode: SEASON, venueSlug: VENUE, seatId, zoneKey: seatId.split('-')[0],
    status: 'busy',
    meta: { hold: { orderId: holdOrderId, until: new Date(Date.now() + 600000), reason: 'checkout' } }
  })));
  await SeatHold.insertMany(seatIds.map(seatId => ({
    eventId: ev._id, seasonCode: SEASON, venueSlug: VENUE, seatId,
    orderId: order._id, reason: 'checkout',
    expiresAt: new Date(Date.now() + 600000)
  })));
  invalidateEventSeatStates(ev._id);
  return { ev, order };
}

async function main() {
  await mongoose.connect(process.env.RELEASECHECK_MONGO_URI || 'mongodb://127.0.0.1:27017', { dbName: DB });
  console.log(`[releasecheck] base isolée: ${DB}\n`);

  for (const form of ['string', 'objectid']) {
    console.log(`meta.hold.orderId écrit en ${form.toUpperCase()}`);
    const { ev, order } = await fixture(['N1-A-001', 'N1-A-002'], form);

    const before = await computeEventSeatStates(ev);
    check('avant : les places sont tenues',
      before.filter(s => s.status === 'busy').length === 2,
      JSON.stringify(before.map(s => `${s.seatId}:${s.status}`)));

    const res = await releaseOrderSeatHolds(order);
    check('les SeatHold sont supprimés', res.holds === 2, `holds=${res.holds}`);
    check('les Seat.meta.hold sont rendus', res.seats === 2, `seats=${res.seats}`);
    check('plus aucun SeatHold en base',
      (await SeatHold.countDocuments({ orderId: order._id })) === 0);
    check("plus aucun siège 'busy'",
      (await Seat.countDocuments({ status: 'busy' })) === 0);

    invalidateEventSeatStates(ev._id);
    const after = await computeEventSeatStates(ev);
    check('le plan de salle les affiche libres',
      after.every(s => s.status === 'available'),
      JSON.stringify(after.map(s => `${s.seatId}:${s.status}`)));
    console.log('');
  }

  // Une commande payée d'un TIERS ne doit pas voir ses places rendues.
  console.log("les places d'une autre commande ne sont pas touchées");
  {
    const { ev, order } = await fixture(['N1-B-001'], 'string');
    await Seat.insertMany([{
      seasonCode: SEASON, venueSlug: VENUE, seatId: 'N1-B-002', zoneKey: 'N1',
      status: 'busy',
      meta: { hold: { orderId: 'une-autre-commande', until: new Date(Date.now() + 600000) } }
    }]);
    // La ligne existe sur NOTRE commande, mais le hold appartient à un autre.
    order.lines.push({
      seatId: 'N1-B-002', zoneKey: 'N1', unitType: 'seat',
      zoneType: 'seated', tariffCode: 'NORMAL', priceCents: 1100
    });
    const res = await releaseOrderSeatHolds(order);
    check('seule notre place est rendue', res.seats === 1, `seats=${res.seats}`);
    const other = await Seat.findOne({ seatId: 'N1-B-002' }).lean();
    check("la place du tiers reste 'busy'", other.status === 'busy', `status=${other.status}`);
    void ev;
  }

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n[releasecheck] base ${DB} supprimée`);
  console.log(failures ? `\n❌ ${failures} assertion(s) en échec` : '\n✅ toutes les assertions passent');
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[releasecheck] fatal:', e);
  try { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } catch {}
  process.exit(1);
});
