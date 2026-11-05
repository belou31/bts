// scripts/06-misc/check-seat-states-cost.js
//
// Vérifie le COÛT du calcul du plan de salle, sur les deux points qui le
// rendaient dominant pendant une ouverture de vente.
//
//   1. L'INDEX. Toutes les vues d'occupation interrogent les deux formes de
//      l'identifiant d'évènement :
//        $or: [ { eventId: ev._id }, { 'meta.eventId': String(ev._id) } ]
//      Sans index sur `meta.eventId`, MongoDB ne peut pas faire d'union
//      d'index et PARCOURT TOUTE la collection `orders` — à chaque sondage,
//      de chaque navigateur ouvert, toutes les 5 secondes.
//
//   2. LE CACHE. La base du plan (sièges de la salle + commandes payées) est
//      identique pour tous les visiteurs ; seuls les verrous de sélection
//      dépendent de celui qui regarde. On ne réutilise donc que la base, et
//      uniquement là où l'appelant le demande : la finalisation et la
//      validation du panier lisent la même fonction SANS cache, sous peine de
//      rouvrir la porte à la double vente.
//
// Usage : npm run test:seat-states-cost   (mongod local requis)
//
// Base ISOLÉE (bts_costcheck), créée et supprimée par ce script : il ne touche
// ni la base de développement `bts`, ni la production.
import mongoose from 'mongoose';
import { Order } from '../../src/models/Order.js';
import { Event } from '../../src/models/Event.js';
import { Seat } from '../../src/models/Seat.js';
import { SeatHold } from '../../src/models/SeatHold.js';
import { computeEventSeatStates, invalidateEventSeatStates } from '../../src/services/event-seat-states.js';

const DB = 'bts_costcheck';
const SEASON = '2026-2027';
const VENUE = 'costcheck-arena';
const SEAT_COUNT = 1200;
const ORDER_COUNT = 1500;

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

/** Noms des index réellement empruntés par un plan de requête. */
function indexesUsed(stage, found = []) {
  if (!stage || typeof stage !== 'object') return found;
  if (stage.stage === 'IXSCAN' && stage.indexName) found.push(stage.indexName);
  if (stage.stage === 'COLLSCAN') found.push('COLLSCAN');
  for (const key of ['inputStage', 'inputStages', 'shards']) {
    const next = stage[key];
    if (Array.isArray(next)) next.forEach(s => indexesUsed(s, found));
    else if (next) indexesUsed(next, found);
  }
  return found;
}

async function main() {
  // `monitorCommands` : sans cette option, le pilote n'émet pas
  // 'commandStarted' et le comptage de requêtes du cas 2 serait muet.
  await mongoose.connect(process.env.COSTCHECK_MONGO_URI || 'mongodb://127.0.0.1:27017',
    { dbName: DB, monitorCommands: true });
  console.log(`[costcheck] base isolée: ${DB}\n`);

  await Promise.all([
    Order.deleteMany({}), Event.deleteMany({}), Seat.deleteMany({}), SeatHold.deleteMany({})
  ]);
  const ev = await Event.create({
    name: 'Costcheck', slug: 'costcheck', seasonCode: SEASON, venueSlug: VENUE,
    startsAt: new Date(Date.now() + 86400000)
  });

  await Seat.insertMany(Array.from({ length: SEAT_COUNT }, (_, i) => ({
    seasonCode: SEASON, venueSlug: VENUE,
    seatId: `N1-${String(Math.floor(i / 40)).padStart(2, '0')}-${String(i % 40).padStart(3, '0')}`,
    zoneKey: 'N1', status: 'available'
  })));

  // Un volume de commandes réaliste, dont une minorité héritée (sans eventId
  // de premier niveau) : c'est elle qui impose de garder la branche $or.
  const otherEventId = new mongoose.Types.ObjectId();
  await Order.insertMany(Array.from({ length: ORDER_COUNT }, (_, i) => {
    const legacy = i % 10 === 0;
    const mine = i % 3 === 0;
    return {
      eventId: legacy ? null : (mine ? ev._id : otherEventId),
      meta: { eventId: String(legacy ? (mine ? ev._id : otherEventId) : (mine ? ev._id : otherEventId)) },
      seasonCode: SEASON, venueSlug: VENUE, status: 'paid',
      payerEmail: `u${i}@example.fr`, totalCents: 1100,
      origin: { flow: 'event' }, mailTemplateKind: 'event',
      lines: [{
        seatId: `N1-${String(Math.floor(i / 40) % 30).padStart(2, '0')}-${String(i % 40).padStart(3, '0')}`,
        zoneKey: 'N1', unitType: 'seat', zoneType: 'seated', tariffCode: 'NORMAL', priceCents: 1100
      }]
    };
  }));

  const occupancyQuery = {
    status: { $in: ['paid', 'tobepaid'] },
    $or: [{ eventId: ev._id }, { 'meta.eventId': String(ev._id) }]
  };

  // ---- 1. Le plan de requête, avant et après l'index.
  console.log('1. Plan de la requête d\'occupation');
  await Order.collection.dropIndexes().catch(() => {});
  await Order.collection.createIndex({ eventId: 1 }, { name: 'eventId_1' });
  {
    const plan = await Order.find(occupancyQuery).explain('queryPlanner');
    const used = indexesUsed(plan.queryPlanner?.winningPlan);
    check('sans idx_legacy_event : parcours complet de la collection',
      used.includes('COLLSCAN'), used.join(', ') || '(aucun)');
  }
  await Order.collection.createIndex({ 'meta.eventId': 1 }, { sparse: true, name: 'idx_legacy_event' });
  {
    const plan = await Order.find(occupancyQuery).explain('executionStats');
    const used = indexesUsed(plan.queryPlanner?.winningPlan);
    check('avec idx_legacy_event : plus aucun parcours complet',
      !used.includes('COLLSCAN'), used.join(', ') || '(aucun)');
    check('les deux branches du $or passent par un index',
      used.includes('eventId_1') && used.includes('idx_legacy_event'), used.join(', '));
    const examined = plan.executionStats?.totalDocsExamined ?? -1;
    check(`documents examinés << ${ORDER_COUNT} commandes`,
      examined >= 0 && examined < ORDER_COUNT,
      `examinés=${examined} sur ${ORDER_COUNT}`);
  }

  // ---- 2. Le cache est opt-in : par défaut, rien n'est réutilisé.
  console.log('\n2. Le cache ne s\'applique que si l\'appelant le demande');
  {
    // On compte les `find` réellement envoyés sur la collection des sièges.
    let commands = 0;
    const onCmd = (e) => { if (e?.commandName === 'find' && e?.command?.find === 'seats') commands++; };
    mongoose.connection.client.on('commandStarted', onCmd);

    commands = 0;
    await computeEventSeatStates(ev);                      // défaut : sans cache
    await computeEventSeatStates(ev);
    const withoutCache = commands;
    check('sans cacheMs : la base est relue à chaque appel', withoutCache === 2,
      `requêtes sur 'seats' = ${withoutCache} (attendu 2)`);

    invalidateEventSeatStates(ev._id);
    commands = 0;
    await computeEventSeatStates(ev, '', { cacheMs: 5000 });
    await computeEventSeatStates(ev, '', { cacheMs: 5000 });
    await computeEventSeatStates(ev, '', { cacheMs: 5000 });
    const withCache = commands;
    check('avec cacheMs : la base est lue une seule fois', withCache === 1,
      `requêtes sur 'seats' = ${withCache} (attendu 1)`);

    // L'invalidation doit forcer une relecture : c'est ce qui garantit qu'une
    // place tout juste payée n'est pas annoncée libre.
    invalidateEventSeatStates(ev._id);
    commands = 0;
    await computeEventSeatStates(ev, '', { cacheMs: 5000 });
    check('invalidateEventSeatStates force une relecture', commands === 1,
      `requêtes sur 'seats' = ${commands} (attendu 1)`);

    mongoose.connection.client.removeListener('commandStarted', onCmd);
  }

  // ---- 3. Le cache ne doit pas se contaminer entre visiteurs.
  console.log('\n3. Le cache ne fuit pas d\'un visiteur à l\'autre');
  {
    await SeatHold.deleteMany({});
    invalidateEventSeatStates(ev._id);
    // Un siège libre APRÈS la surcouche des commandes payées : en prendre un
    // au hasard dans `Seat` tomberait sur une place déjà vendue.
    const baseline = await computeEventSeatStates(ev);
    const seatId = baseline.find(s => s.status === 'available')?.seatId;
    check('un siège libre existe pour ce cas', Boolean(seatId), `seatId=${seatId}`);
    await SeatHold.create({
      eventId: ev._id, seasonCode: SEASON, venueSlug: VENUE, seatId,
      sessionToken: 'alice', reason: 'selection',
      expiresAt: new Date(Date.now() + 600000)
    });
    invalidateEventSeatStates(ev._id);

    const asAlice = await computeEventSeatStates(ev, 'alice', { cacheMs: 5000 });
    const asBob   = await computeEventSeatStates(ev, 'bob',   { cacheMs: 5000 });
    const asAlice2 = await computeEventSeatStates(ev, 'alice', { cacheMs: 5000 });

    const st = (rows) => rows.find(s => s.seatId === seatId)?.status;
    check('sa propre sélection reste disponible pour Alice', st(asAlice) === 'available', `${seatId}=${st(asAlice)}`);
    check("la sélection d'Alice est 'busy' pour Bob", st(asBob) === 'busy', `${seatId}=${st(asBob)}`);
    check("le passage de Bob n'a pas contaminé le cache d'Alice",
      st(asAlice2) === 'available', `${seatId}=${st(asAlice2)}`);
  }

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n[costcheck] base ${DB} supprimée`);
  console.log(failures ? `\n❌ ${failures} assertion(s) en échec` : '\n✅ toutes les assertions passent');
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[costcheck] fatal:', e);
  try { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } catch {}
  process.exit(1);
});
