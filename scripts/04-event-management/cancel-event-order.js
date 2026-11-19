#!/usr/bin/env node
/**
 * Annule (soft) ou supprime (hard) une commande de MATCH, et révoque ses billets.
 *
 * Pour un abonnement ou un renouvellement, utiliser
 * scripts/03-season-management/cancel-season-order.js.
 *
 * TROIS MODES, parce que « annuler » recouvre deux intentions distinctes :
 *
 *   soft    — la commande passe à `canceled`, ses billets sont révoqués. La
 *             place n'est PAS remise en vente pour ce match : une commande
 *             annulée sort du calcul d'occupation, et le siège retombe sur son
 *             état de saison. Pour une commande dérivée d'un abonnement, il
 *             revient donc à l'abonné — ce qui est correct quand la commande de
 *             match était une erreur, et faux quand on voulait libérer la place.
 *   release — la commande RESTE payée, ses lignes passent à `released` et ses
 *             billets sont révoqués : la place devient disponible POUR CE MATCH
 *             seulement, le siège de saison restant acquis à son détenteur.
 *             C'est le mode qui convient à un abonné qui manque un match.
 *   hard    — le document est supprimé, sans retour.
 *
 * Vérifié : sur une commande dérivée d'un abonnement, `release` rend la place
 * `available` pour ce match tandis que Seat.status reste `booked` ; `soft` la
 * laisse `booked` des deux côtés.
 *
 * Les verrous de sélection (SeatHold) de la commande sont levés dans tous les cas.
 *
 * LE GARDE-FOU : --release-seats rend le siège de SAISON. Sur une commande
 * dérivée d'un abonnement (`parentOrderId` renseigné), c'est refusé — cela
 * retirerait sa place à l'abonné pour toute la saison alors qu'un seul match
 * est en cause.
 *
 * Usage:
 *   node scripts/04-event-management/cancel-event-order.js --order=<id> [--event=<slug|id>] [--mode=soft|hard]
 *   node scripts/04-event-management/cancel-event-order.js --file=<orders.csv>
 *   ... [--commit] [--force] [--release-seats]
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 *   - MONGODB_DB (nom de base, optionnel)
 */
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { Order } from '../../src/models/Order.js';
import { Event } from '../../src/models/Event.js';
import { Seat } from '../../src/models/Seat.js';
import { SeatHold } from '../../src/models/SeatHold.js';
import { Ticket } from '../../src/models/Ticket.js';
import { resolveLinePlacement, applyAttendancePatch } from '../../src/utils/event-attendance.js';
import {
  resolveTargets, loadOrder, revokeTickets, shouldSkipPaid,
  describeOrder, realSeatIds, markCanceled, summarize, isObjectId
} from '../lib/order-cancel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const argv = yargs(hideBin(process.argv))
  .option('order',  { type: 'string', desc: 'Identifiant d\'une commande' })
  .option('file',   { type: 'string', desc: 'CSV : colonnes orderId, mode' })
  .option('event',  { type: 'string', desc: 'Slug ou identifiant du match (vérification facultative)' })
  .option('mode',   { type: 'string', default: 'soft', choices: ['soft', 'release', 'hard'],
                      desc: 'soft = annuler · release = libérer la place pour ce match · hard = supprimer' })
  .option('commit', { type: 'boolean', default: false })
  .option('force',  { type: 'boolean', default: false, desc: 'Autorise une commande payée' })
  .option('release-seats', { type: 'boolean', default: false, desc: 'Rend aussi le siège de saison' })
  .help().argv;

async function resolveEvent(order) {
  const evId = order.meta?.eventId || order.eventId;
  const evSlug = order.meta?.eventSlug || null;
  let doc = null;
  if (evId) doc = await Event.findById(evId).lean().catch(() => null);
  if (!doc && evSlug) doc = await Event.findOne({ slug: evSlug }).lean();
  return doc;
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  await mongoose.connect(uri, process.env.MONGODB_DB ? { dbName: process.env.MONGODB_DB } : {});

  const list = await resolveTargets(argv);
  const eventKey = String(argv.event || '').trim();
  const releaseSeats = argv['release-seats'];
  console.log(argv.commit ? '⚠️  Commit activé.' : '🧪 Simulation (aucune écriture).');

  let soft = 0, hard = 0, miss = 0, skipped = 0, released = 0, revoked = 0;

  for (const { orderId, mode } of list) {
    const order = await loadOrder(Order, orderId);
    if (!order) { console.warn(`❓ introuvable ${orderId}`); miss++; continue; }

    const seatIds = realSeatIds(order);
    describeOrder(order, seatIds);

    const eventDoc = await resolveEvent(order);
    if (!eventDoc) {
      console.log('  ⛔ commande sans match rattaché — utiliser :');
      console.log(`     node scripts/03-season-management/cancel-season-order.js --order=${order._id}`);
      skipped++;
      continue;
    }
    if (eventKey) {
      const matches = (isObjectId(eventKey) && String(eventDoc._id) === eventKey) || eventDoc.slug === eventKey;
      if (!matches) {
        console.log(`  ⛔ liée à ${eventDoc.slug || eventDoc._id}, et non à ${eventKey} — ignorée.`);
        skipped++;
        continue;
      }
    }
    console.log(`  match  : ${eventDoc.slug || eventDoc._id}`);
    if (shouldSkipPaid(order, argv.force)) { skipped++; continue; }

    // Le garde-fou qui justifie deux scripts : rendre le siège d'un abonné
    // le lui retirerait pour toute la saison, alors qu'il ne manque qu'un match.
    const derived = Boolean(order.parentOrderId);
    const willReleaseSeats = releaseSeats && !derived;
    if (releaseSeats && derived) {
      console.log('  ⚠ commande dérivée d\'un abonnement : le siège de saison n\'est PAS rendu.');
      console.log('     Le rendre priverait l\'abonné de sa place toute la saison.');
    }
    // Dit avant d'agir, parce que c'est le contresens facile : une commande
    // annulée sort du calcul d'occupation, donc la place n'est pas libérée
    // pour ce match — elle retombe sur son état de saison.
    if (mode === 'soft' && derived) {
      console.log('  ⚠ mode « soft » sur une commande dérivée : la place revient à l\'abonné');
      console.log('     et ne sera PAS revendable pour ce match. Pour la libérer : --mode=release');
    }

    if (!argv.commit) {
      console.log(`  🧪 ${mode.toUpperCase()} — `
        + (mode === 'release' ? 'commande maintenue payée, lignes « released »'
          : mode === 'hard' ? 'document supprimé'
          : 'commande annulée, lignes « released »')
        + (willReleaseSeats ? `, ${seatIds.length} siège(s) de saison rendu(s)` : ', siège de saison intact'));
      continue;
    }

    const ticketsRemoved = await revokeTickets(Ticket, order);
    revoked += ticketsRemoved;
    const suffix = ticketsRemoved ? ` · ${ticketsRemoved} billet(s) révoqué(s)` : '';

    if (mode === 'hard') {
      await Order.deleteOne({ _id: order._id });
      hard++;
      console.log(`  ✔ supprimée${suffix}`);
    } else {
      // La surcouche de présence : c'est elle que lit computeEventSeatStates.
      // Elle n'est prise en compte que sur une commande `paid`/`tobepaid` —
      // d'où le mode `release`, qui laisse la commande payée exprès.
      order.lines = (order.lines || []).map((line) => {
        const placement = resolveLinePlacement(line);
        return {
          ...(line.toObject?.() ?? line),
          attendance: applyAttendancePatch(line, {
            status: 'released', overrideZoneKey: placement.zoneKey
          }, new Date(), 'cancel-event-order')
        };
      });
      order.markModified('lines');

      if (mode === 'release') {
        order.meta = order.meta || {};
        order.meta.releasedForEventAt = new Date();
        order.markModified('meta');
        await order.save();
        soft++;
        console.log(`  ✔ place libérée pour ce match · commande maintenue « ${order.status} »${suffix}`);
      } else {
        markCanceled(order);
        await order.save();
        soft++;
        console.log(`  ✔ annulée (canceled) · lignes « released »${suffix}`);
      }
    }

    const holds = await SeatHold.deleteMany({ orderId: order._id }).catch(() => ({ deletedCount: 0 }));
    if (holds.deletedCount) console.log(`  ✔ ${holds.deletedCount} verrou(x) de sélection levé(s)`);

    if (willReleaseSeats && seatIds.length) {
      const upd = await Seat.updateMany(
        { seasonCode: eventDoc.seasonCode, venueSlug: eventDoc.venueSlug, seatId: { $in: seatIds } },
        { $set: { status: 'available' }, $unset: { 'meta.hold': 1, provisionedFor: 1 } }
      );
      const n = Number(upd.modifiedCount ?? upd.nModified ?? 0);
      released += n;
      console.log(`  ✔ ${n} siège(s) de saison rendu(s)`);
    }
  }

  summarize({ soft, hard, skipped, miss, revoked, released });
  if (!argv.commit) console.log('Simulation seule. Relancer avec --commit pour écrire.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err?.message || err);
  try { await mongoose.disconnect(); } catch { /* rien de mieux à faire */ }
  process.exit(1);
});
