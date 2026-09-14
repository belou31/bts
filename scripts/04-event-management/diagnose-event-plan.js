#!/usr/bin/env node
/**
 * Pourquoi telle place n'apparaît-elle pas réservée sur admin/plan ?
 *
 * Le plan d'un match ne lit pas `Seat.status` pour décider qu'une place est
 * prise : pour un événement, les sièges ne sont volontairement PAS passés à
 * `booked` dans la collection Seat (voir order-finalization.js, branche
 * ÉVÈNEMENT). L'occupation est recalculée à l'affichage en superposant les
 * commandes payées du match. Cette chaîne comporte quatre maillons, et chacun
 * écarte une place en silence :
 *
 *   1. la commande est-elle rattachée au match (eventId / meta.eventId /
 *      meta.eventSlug) et dans un statut retenu (paid, tobepaid) ?
 *   2. la ligne est-elle marquée « released » (place rendue pour ce match) ?
 *   3. l'identifiant de place est-il un siège réel, et non un id virtuel de zone ?
 *   4. existe-t-il un document Seat AVEC EXACTEMENT cet identifiant, pour la
 *      saison et le lieu du match ? (comparaison sensible à la casse)
 *
 * Lecture seule.
 *
 * Usage:
 *   node scripts/04-event-management/diagnose-event-plan.js --event=<slug|id> [--seat=<seatId>]
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { Order, Event, Seat } from '../../src/models/index.js';
import { resolveLinePlacement } from '../../src/utils/event-attendance.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const arg = (n) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') || null;

// Même heuristique que src/utils/seat-id.js pour les places de zone.
const isVirtualZoneSeatId = (id) => /-Z\d+$/i.test(String(id || ''));

async function main() {
  const ref = arg('event');
  if (!ref) {
    console.error('Usage: node scripts/04-event-management/diagnose-event-plan.js --event=<slug|id> [--seat=<seatId>]');
    process.exit(1);
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  mongoose.set('strictQuery', true);   // comme le serveur
  await mongoose.connect(uri);

  const ev = /^[0-9a-f]{24}$/i.test(ref)
    ? await Event.findById(ref).lean()
    : await Event.findOne({ slug: ref }).lean();
  if (!ev) throw new Error(`Événement introuvable : ${ref}`);

  // admin/plan prend la saison et le lieu DU MATCH, pas ceux de l'URL.
  const seasonCode = ev.seasonCode, venueSlug = ev.venueSlug;
  console.log(`\n${ev.slug}`);
  console.log(`  saison / lieu du match : ${seasonCode} / ${venueSlug}`);

  const seats = await Seat.find({ seasonCode, venueSlug }, { seatId: 1, status: 1, _id: 0 }).lean();
  const known = new Map(seats.map(s => [String(s.seatId).trim(), s.status]));
  console.log(`  places connues pour ce couple : ${seats.length}`);
  if (!seats.length) {
    console.log('  ⚠ AUCUNE place : le plan ne peut rien marquer. Les sièges sont-ils');
    console.log('    instanciés pour CETTE saison et CE lieu ? (une saison clonée porte');
    console.log('    souvent un code différent de celui des sièges d\'origine)');
  }

  // Maillon 1 — exactement la requête d'admin/plan.
  const match = {
    $or: [
      { eventId: String(ev._id) },
      { 'meta.eventId': String(ev._id) },
      ...(ev.slug ? [{ 'meta.eventSlug': String(ev.slug) }] : [])
    ],
    status: { $in: ['paid', 'tobepaid'] }
  };
  const orders = await Order.find(match, { _id: 1, status: 1, lines: 1, eventId: 1, meta: 1 }).lean();
  console.log(`\n  commandes retenues par le plan : ${orders.length}`);
  if (!orders.length) {
    const loose = await Order.countDocuments({ seasonCode, venueSlug, 'origin.flow': 'event' });
    console.log('  ⚠ aucune commande rattachée. Commandes « event » sur cette saison/lieu :', loose);
    console.log('    Si ce nombre est > 0, leur rattachement au match est absent :');
    console.log('    ni eventId, ni meta.eventId, ni meta.eventSlug ne pointent vers lui.');
  }

  const wanted = arg('seat');
  let shown = 0, booked = 0;
  const problems = [];

  for (const o of orders) {
    for (const line of (o.lines || [])) {
      const placement = resolveLinePlacement(line);
      const seatId = String(placement?.seatId || line?.seatId || '').trim();
      if (wanted && seatId !== wanted) continue;

      if (placement?.released) {
        problems.push(`${seatId || '(sans place)'} — ligne « released » : place rendue pour ce match (commande ${o._id})`);
        continue;
      }
      if (!seatId) {
        problems.push(`(ligne sans seatId, zone ${line.zoneKey || '—'}) — place en zone : le plan ne marque que les sièges (commande ${o._id})`);
        continue;
      }
      if (isVirtualZoneSeatId(seatId)) {
        problems.push(`${seatId} — identifiant virtuel de zone, ignoré par le plan (commande ${o._id})`);
        continue;
      }
      if (!known.has(seatId)) {
        // Le maillon le plus discret : la comparaison est exacte.
        const near = [...known.keys()].find(k => k.toLowerCase() === seatId.toLowerCase());
        problems.push(`${seatId} — AUCUN document Seat pour ${seasonCode} / ${venueSlug}`
          + (near ? ` — mais « ${near} » existe : différence de casse` : ' — vérifier l\'identifiant exact')
          + ` (commande ${o._id})`);
        continue;
      }
      booked += 1;
      shown += 1;
      console.log(`  ✔ ${seatId} marquée « booked » (Seat.status=${known.get(seatId)}, commande ${o._id})`);
    }
  }

  if (problems.length) {
    console.log(`\n  ⚠ ${problems.length} place(s) que le plan n'affichera PAS réservées :`);
    for (const p of problems) console.log(`     ${p}`);
  }
  if (!problems.length && booked) {
    console.log(`\n  ✔ Les ${booked} place(s) de ce match s'affichent réservées sur le plan du MATCH.`);
    console.log('    Sur le plan de SAISON elles n\'apparaissent pas : une commande de match');
    console.log('    en est exclue par construction. Vérifier le sélecteur de match.');
  }
  if (!shown && !problems.length) {
    console.log('\n  (aucune ligne de place à examiner)');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err.message || err);
  try { await mongoose.disconnect(); } catch { /* rien de mieux à faire */ }
  process.exit(1);
});
