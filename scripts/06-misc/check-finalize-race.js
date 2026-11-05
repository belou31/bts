// scripts/06-misc/check-finalize-race.js
//
// Vérifie qu'une commande ne peut pas être finalisée deux fois.
//
// CE QUE CELA PROTÈGE. Quatre chemins finalisent la même commande — retour de
// paiement, webhook, sondage /pay/status, sentinelle — et pour 44 % des
// commandes payées du match du 03/10/2026 au moins deux d'entre eux se sont
// exécutés. Sans exclusion mutuelle, le second travaillait sur un document
// chargé avant le premier : il voyait `pending`, trouvait la place « booked »
// par la commande que l'autre venait de payer, et repassait la commande en
// `failed` — billets déjà expédiés, place rendue vendable.
//
// Sans le correctif, le cas 2 de ce script reproduit l'incident à l'identique.
//
// Usage : npm run test:finalize-race   (mongod local requis)
//
// Base ISOLÉE (bts_racecheck), créée et supprimée par ce script : il ne touche
// ni la base de développement `bts`, ni la production.
import mongoose from 'mongoose';
import { Order } from '../../src/models/Order.js';
import { Event } from '../../src/models/Event.js';
import { Seat } from '../../src/models/Seat.js';
import { SeatHold } from '../../src/models/SeatHold.js';
import { finalizePaidIfNoConflict } from '../../src/services/order-finalization.js';

const DB = 'bts_racecheck';
const SEASON = '2026-2027';
const VENUE = 'racecheck-arena';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

async function freshFixture(seatIds) {
  await Promise.all([
    Order.deleteMany({}), Event.deleteMany({}), Seat.deleteMany({}), SeatHold.deleteMany({})
  ]);
  const ev = await Event.create({
    name: 'Racecheck', slug: 'racecheck', seasonCode: SEASON, venueSlug: VENUE,
    startsAt: new Date(Date.now() + 86400000)
  });
  await Seat.insertMany(seatIds.map(seatId => ({
    seasonCode: SEASON, venueSlug: VENUE, seatId,
    zoneKey: seatId.split('-')[0], status: 'available'
  })));
  const order = await Order.create({
    eventId: ev._id, seasonCode: SEASON, venueSlug: VENUE, status: 'pending',
    payerEmail: 'racecheck@example.fr', totalCents: 1100 * seatIds.length,
    origin: { flow: 'event' }, mailTemplateKind: 'event',
    meta: { eventId: String(ev._id) },
    lines: seatIds.map(seatId => ({
      seatId, zoneKey: seatId.split('-')[0], unitType: 'seat',
      zoneType: 'seated', tariffCode: 'NORMAL', priceCents: 1100
    }))
  });
  // Le verrou de siège que le flux d'achat aurait posé.
  await SeatHold.insertMany(seatIds.map(seatId => ({
    eventId: ev._id, seasonCode: SEASON, venueSlug: VENUE, seatId,
    orderId: order._id, reason: 'checkout',
    expiresAt: new Date(Date.now() + 600000)
  })));
  return { ev, order };
}

async function main() {
  await mongoose.connect(process.env.RACECHECK_MONGO_URI || 'mongodb://127.0.0.1:27017', { dbName: DB });
  console.log(`[racecheck] base isolée: ${DB}\n`);

  // ---- 1. La course : deux chemins finalisent la même commande en parallèle.
  console.log('1. Course /pay/return vs webhook (deux documents, en parallèle)');
  {
    const { order } = await freshFixture(['N1-A-001', 'N1-A-002']);
    // Exactement ce que font les deux routes : chacune charge SON document.
    const [docA, docB] = await Promise.all([
      Order.findById(order._id), Order.findById(order._id)
    ]);
    const [resA, resB] = await Promise.all([
      finalizePaidIfNoConflict(docA), finalizePaidIfNoConflict(docB)
    ]);

    const winners = [resA, resB].filter(r => r.ok && r.booked > 0);
    const others = [resA, resB].filter(r => !(r.ok && r.booked > 0));
    check('un seul chemin réserve les places', winners.length === 1,
      `booked=${[resA, resB].map(r => r.booked).join('/')}`);
    check('le perdant ne crie pas au conflit',
      others.every(r => r.ok || r.inFlight),
      `perdant=${JSON.stringify(others.map(r => ({ ok: r.ok, inFlight: !!r.inFlight, conflicts: r.conflicts })))}`);

    const db = await Order.findById(order._id).lean();
    check("la commande est 'paid' en base", db.status === 'paid', `status=${db.status}`);
    check('aucun des deux documents ne porte failed',
      docA.status !== 'failed' && docB.status !== 'failed',
      `A=${docA.status} B=${docB.status}`);

    // Le geste qui écrasait tout : l'appelant enregistre son document après coup.
    await docA.save().catch(() => {});
    await docB.save().catch(() => {});
    const after = await Order.findById(order._id).lean();
    check("un save() tardif de l'appelant ne dégrade plus le statut",
      after.status === 'paid', `status=${after.status}`);
  }

  // ---- 2. Rejeu séquentiel : le second appel doit reconnaître l'acquis.
  console.log('\n2. Rejeu séquentiel (webhook qui arrive après le retour)');
  {
    const { order } = await freshFixture(['N1-B-001']);
    const docA = await Order.findById(order._id);
    const docB = await Order.findById(order._id); // chargé AVANT, donc périmé
    const r1 = await finalizePaidIfNoConflict(docA);
    const r2 = await finalizePaidIfNoConflict(docB);
    check('le premier réussit', r1.ok && r1.booked === 1, `booked=${r1.booked}`);
    check('le second signale alreadyFinalized', r2.ok && r2.alreadyFinalized === true,
      JSON.stringify({ ok: r2.ok, already: r2.alreadyFinalized, conflicts: r2.conflicts }));
    check('le document périmé a été réaligné sur paid', docB.status === 'paid', `status=${docB.status}`);
    const db = await Order.findById(order._id).lean();
    check("la commande reste 'paid'", db.status === 'paid', `status=${db.status}`);
  }

  // ---- 3. Un conflit RÉEL doit toujours échouer (pas de régression).
  console.log('\n3. Conflit réel : la place est prise par une AUTRE commande payée');
  {
    const { ev, order } = await freshFixture(['N1-C-001']);
    await Order.create({
      eventId: ev._id, seasonCode: SEASON, venueSlug: VENUE, status: 'paid',
      payerEmail: 'squatter@example.fr', totalCents: 1100,
      origin: { flow: 'event' }, mailTemplateKind: 'event',
      meta: { eventId: String(ev._id) },
      lines: [{ seatId: 'N1-C-001', zoneKey: 'N1', unitType: 'seat', zoneType: 'seated', tariffCode: 'NORMAL', priceCents: 1100 }]
    });
    await SeatHold.deleteMany({ orderId: order._id }); // nos verrous sont tombés
    const doc = await Order.findById(order._id);
    const res = await finalizePaidIfNoConflict(doc);
    check('le conflit réel est bien refusé', res.ok === false && !res.inFlight,
      JSON.stringify({ ok: res.ok, inFlight: !!res.inFlight, conflicts: res.conflicts }));
    const db = await Order.findById(order._id).lean();
    check("la commande passe 'failed'", db.status === 'failed', `status=${db.status}`);
    check('la cause est consignée', db.paymentProviderMeta?.failureReason === 'seat_conflict',
      `failureReason=${db.paymentProviderMeta?.failureReason}`);
  }

  // ---- 4. Une commande annulée reste intouchable.
  console.log('\n4. Commande annulée : finalisation bloquée');
  {
    const { order } = await freshFixture(['N1-D-001']);
    await Order.updateOne({ _id: order._id }, { $set: { status: 'canceled' } });
    const doc = await Order.findById(order._id);
    doc.status = 'pending'; // document périmé, comme une route qui l'a chargé avant
    const res = await finalizePaidIfNoConflict(doc);
    check('bloquée', res.ok === false && res.blocked === true, JSON.stringify(res.conflicts));
    const db = await Order.findById(order._id).lean();
    check("reste 'canceled'", db.status === 'canceled', `status=${db.status}`);
    check('le document périmé est réaligné', doc.status === 'canceled', `status=${doc.status}`);
  }

  // ---- 4bis. Une commande `failed` doit rester RÉPARABLE.
  //
  // C'est l'état d'un paiement encaissé dont les places n'ont pas pu être
  // posées — ce que check-order-payment.js existe pour reprendre. Le verrou
  // de finalisation l'avait rendu infinalisable : la reprise répondait
  // « conflit de sièges — finalize_in_flight » sur une commande qui n'avait
  // aucune finalisation en cours.
  console.log("\n4bis. Reprise d'une commande 'failed' (outil de réparation)");
  {
    const { order } = await freshFixture(['N1-F-001']);
    // On la met dans l'état où un conflit l'a laissée.
    await Order.updateOne({ _id: order._id }, {
      $set: {
        status: 'failed',
        'paymentProviderMeta.failureReason': 'seat_conflict',
        'paymentProviderMeta.failurePhase': 'post_payment',
        'paymentProviderMeta.failedAt': new Date(),
        'paymentProviderMeta.conflict': { kind: 'seat_conflict', seats: [{ seatId: 'N1-F-001', reason: 'busy_other' }] }
      }
    });

    const doc = await Order.findById(order._id);
    const res = await finalizePaidIfNoConflict(doc);
    check('la reprise aboutit', res.ok === true && res.booked === 1,
      JSON.stringify({ ok: res.ok, booked: res.booked, inFlight: !!res.inFlight, conflicts: res.conflicts }));
    check("ce n'est PAS annoncé comme 'finalize_in_flight'", !res.inFlight);

    const db = await Order.findById(order._id).lean();
    check("la commande passe 'paid'", db.status === 'paid', `status=${db.status}`);
    // La trace de l'échec précédent doit disparaître, sinon les exports
    // décrivent une commande payée comme ayant échoué.
    check('la cause d\'échec est effacée', !db.paymentProviderMeta?.failureReason,
      `failureReason=${db.paymentProviderMeta?.failureReason}`);
    check('le détail du conflit est effacé', !db.paymentProviderMeta?.conflict,
      `conflict=${JSON.stringify(db.paymentProviderMeta?.conflict)}`);
  }

  // ---- 4ter. Un état ni payable ni en vol doit être NOMMÉ.
  console.log("\n4ter. Un état non finalisable n'est pas déguisé en conflit");
  {
    const { order } = await freshFixture(['N1-G-001']);
    await Order.updateOne({ _id: order._id }, { $set: { status: 'torelocate' } });
    const doc = await Order.findById(order._id);
    doc.status = 'pending'; // document périmé
    const res = await finalizePaidIfNoConflict(doc);
    check('refusée et nommée', res.ok === false && res.blocked === true &&
      res.conflicts?.[0]?.reason === 'order_not_finalizable',
      JSON.stringify(res.conflicts));
    check("pas annoncée 'en vol'", !res.inFlight);
  }

  // ---- 5. Le verrou est rendu : une commande n'est pas figée par un échec.
  console.log('\n5. Le verrou de finalisation est rendu après usage');
  {
    const { order } = await freshFixture(['N1-E-001']);
    const doc = await Order.findById(order._id);
    await finalizePaidIfNoConflict(doc);
    const db = await Order.findById(order._id).lean();
    check('finalizeLockAt rendu', !db.paymentProviderMeta?.finalizeLockAt,
      `lock=${db.paymentProviderMeta?.finalizeLockAt}`);
    check('compteur de tentative conservé', db.paymentProviderMeta?.finalizeAttemptCount === 1,
      `count=${db.paymentProviderMeta?.finalizeAttemptCount}`);
  }

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n[racecheck] base ${DB} supprimée`);
  console.log(failures ? `\n❌ ${failures} assertion(s) en échec` : '\n✅ toutes les assertions passent');
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[racecheck] fatal:', e);
  try { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } catch {}
  process.exit(1);
});
