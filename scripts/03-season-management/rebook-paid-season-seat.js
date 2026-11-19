#!/usr/bin/env node
/**
 * Repairs a SEASON (non-event) order that's `paid` but whose season seat was
 * never actually flipped to `booked` in the `Seat` collection.
 *
 * Why this can happen: finalizePaidIfNoConflict() (src/services/order-finalization.js)
 * only attempts the seat-booking write while CLAIMING the finalize lock — once
 * an order's status is already 'paid', every repair path that relies on it
 * (check-order-payment.js, the sentinel, /pay/return, the webhook) short-
 * circuits with `alreadyFinalized: true` and never re-checks the seat. If a
 * 'paid' status ever lands without that write actually sticking — a prior
 * conflict+retry cycle that left stale bookkeeping, an import or manual
 * correction that set status='paid' directly — nothing in the normal flow
 * can fix it afterwards. This tool re-attempts exactly that one write,
 * outside the finalize-lock gate, with the same eligibility check the real
 * success path uses (never forces past a seat genuinely held by someone/
 * something else).
 *
 * Deliberately refuses anything event-scoped: an event order's occupancy is
 * a per-event overlay (src/services/event-seat-states.js), computed from
 * paid orders, never Seat.status — there is nothing to "rebook" there, and
 * this tool must not be used on it.
 *
 * Usage:
 *   node scripts/03-season-management/rebook-paid-season-seat.js --order=<id> [--commit]
 *
 * Dry-run by default; the Seat write + order.save() only happen with --commit.
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { connectMongo, logDryRun } from '../_utils.js';
import { Order } from '../../src/models/Order.js';
import { Seat } from '../../src/models/Seat.js';
import { realSeatIdsFromOrder, isPaidLike } from '../../src/services/order-finalization.js';

const argv = yargs(hideBin(process.argv))
  .option('order', { type: 'string', demandOption: true, desc: 'Order ObjectId' })
  .option('commit', { type: 'boolean', default: false })
  .help()
  .argv;

const DRY_RUN = argv.commit !== true;

function clearFailureStamp(meta) {
  delete meta.failureReason;
  delete meta.failurePhase;
  delete meta.failedAt;
}

async function main() {
  await connectMongo();
  logDryRun(argv.commit);

  const order = await Order.findById(argv.order);
  if (!order) {
    console.error(`❌ Order introuvable: ${argv.order}`);
    process.exit(1);
  }

  const eventIdRaw = order.eventId || order?.meta?.eventId;
  if (eventIdRaw) {
    console.error(
      `❌ Order ${order._id} est rattachée à un évènement (eventId=${eventIdRaw}) — ` +
      `cet outil ne concerne que les commandes SAISON. Une commande évènement n'écrit ` +
      `jamais Seat.status : rien à réparer ici, voir computeEventSeatStates.`
    );
    process.exit(1);
  }

  if (!isPaidLike(order.status)) {
    console.error(
      `❌ Order ${order._id} status="${order.status}" (pas payée) — rien à réparer ici. ` +
      `Si elle doit être finalisée, utilisez scripts/06-misc/check-order-payment.js.`
    );
    process.exit(1);
  }

  const seasonCode = order.seasonCode;
  const venueSlug = order.venueSlug;
  if (!seasonCode || !venueSlug) {
    console.error(`❌ Order ${order._id} : seasonCode/venueSlug manquant(s).`);
    process.exit(1);
  }

  const seatIds = realSeatIdsFromOrder(order);
  if (!seatIds.length) {
    console.log(`ℹ️  Order ${order._id} n'a aucune ligne « siège réel » (zone uniquement, ou déjà libérée) — rien à booker.`);
    process.exit(0);
  }

  console.log(`→ Order: ${order._id} (${order.payerEmail || 'email inconnu'})`);
  console.log(`→ Saison/lieu: ${seasonCode} / ${venueSlug}`);
  console.log(`→ Sièges: ${seatIds.join(', ')}`);

  const seatsRaw = await Seat.find({ seasonCode, venueSlug, seatId: { $in: seatIds } }).lean();
  const byId = new Map(seatsRaw.map(s => [s.seatId, s]));

  const notFound = seatIds.filter(sid => !byId.has(sid));
  if (notFound.length) {
    console.error(`❌ Siège(s) introuvable(s) dans le catalogue: ${notFound.join(', ')} — abandon.`);
    process.exit(1);
  }

  // Seat.status ne garde aucune trace de « quelle commande a booké ce siège »
  // une fois status='booked' (pas de champ orderId écrit par le chemin réel
  // de succès) — on ne peut donc pas distinguer après coup « déjà booké par
  // CETTE commande » de « booké par quelqu'un d'autre » depuis le document
  // Seat seul. Le seul signal fiable est celui que la commande porte déjà
  // elle-même : finalizedSeatIds, écrit par ce script ou par le chemin réel
  // sur un succès. Il doit être vérifié AVANT le filtre d'éligibilité, sinon
  // relancer le script après un succès précédent se lit comme un blocage.
  const alreadyFinalizedSeatIds = new Set(order.paymentProviderMeta?.finalizedSeatIds || []);
  const alreadyDone = (sid) => byId.get(sid).status === 'booked' && alreadyFinalizedSeatIds.has(sid);

  // Même condition d'éligibilité que le succès réel (order-finalization.js) :
  // available/provisioned, ou busy déjà tenu par CETTE commande. Jamais une
  // place booked/busy tenue par quelqu'un d'autre — ça demande une décision
  // humaine (réallocation, remboursement), pas une réécriture forcée.
  const isHonorable = (seat) => {
    if (seat.status === 'available' || seat.status === 'provisioned') return true;
    if (seat.status === 'busy') {
      const holdOrderId = seat.meta?.hold?.orderId;
      return holdOrderId != null && String(holdOrderId) === String(order._id);
    }
    return false;
  };

  const toRepair = seatIds.filter(sid => !alreadyDone(sid));

  if (!toRepair.length) {
    console.log('✅ Déjà booké(s) par cette commande (finalizedSeatIds) — rien à faire.');
    process.exit(0);
  }

  const blocked = toRepair.filter(sid => !isHonorable(byId.get(sid)));
  if (blocked.length) {
    console.error('❌ Siège(s) dans un état non réparable automatiquement :');
    for (const sid of blocked) {
      const s = byId.get(sid);
      console.error(`   ${sid}: status=${s.status}${s.meta?.hold ? ' hold=' + JSON.stringify(s.meta.hold) : ''}`);
    }
    console.error('Une place déjà booked/busy pour un autre titulaire (ou booké sans que finalizedSeatIds le confirme pour cette commande) exige une décision humaine (réallocation ou remboursement) — ce script ne force jamais ce cas.');
    process.exit(1);
  }

  console.log(`✓ ${toRepair.length} siège(s) dans un état réparable (available/provisioned/busy-par-cette-commande)${toRepair.length < seatIds.length ? `, ${seatIds.length - toRepair.length} déjà booké(s)` : ''}.`);

  if (DRY_RUN) {
    console.log('[dry-run] Écrirait Seat.status=booked pour ces sièges, et mettrait à jour paymentProviderMeta de la commande.');
    process.exit(0);
  }

  const now = new Date();
  const upd = await Seat.updateMany(
    {
      seasonCode, venueSlug, seatId: { $in: toRepair },
      $or: [
        { status: 'available' },
        { status: 'provisioned' },
        { status: 'busy', 'meta.hold.orderId': order._id },
        { status: 'busy', 'meta.hold.orderId': String(order._id) }
      ]
    },
    { $set: { status: 'booked' }, $unset: { 'meta.hold': 1, provisionedFor: 1 } },
    { runValidators: false }
  );
  const modified = Number(upd.modifiedCount ?? upd.nModified ?? 0);

  if (modified !== toRepair.length) {
    console.error(
      `❌ Écriture partielle (${modified}/${toRepair.length}) — un siège a changé d'état entre la vérification ` +
      `et l'écriture (course avec un autre processus). Relancez le script pour réévaluer l'état actuel.`
    );
    process.exit(1);
  }

  const meta = { ...(order.paymentProviderMeta || {}) };
  meta.finalizedSeatIds = seatIds;
  meta.lastFinalizeResult = 'success';
  meta.lastSuccessfulFinalizeAt = now;
  meta.repairedAt = now;
  meta.repairedBy = 'rebook-paid-season-seat.js';
  if (meta.conflict) delete meta.conflict;
  clearFailureStamp(meta);
  order.paymentProviderMeta = meta;
  await order.save();

  console.log(`✅ ${modified} siège(s) repassé(s) 'booked' pour la commande ${order._id}.`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌ ERROR:', err?.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
