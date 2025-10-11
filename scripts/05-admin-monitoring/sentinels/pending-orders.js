/**
 * Sentinel to monitor pending HelloAsso orders.
 *
 * Checks pending orders, finalises those marked as paid by HelloAsso, and
 * performs housekeeping (release expired holds, cancel stale pending orders).
 *
 * Usage:
 *   node scripts/04-admin-monitoring/sentinels/pending-orders.js [--sinceMinutes=180]
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 *   - MONGODB_DB (optional database name)
 *   - CHECKOUT_HOLD_MIN, PENDING_MAX_MIN (optional overrides)
 */

import 'dotenv/config';

import mongoose from 'mongoose';
import { Order } from '../../../src/models/Order.js';
import { Seat }  from '../../../src/models/Seat.js';
import { getCheckoutStatus } from '../../../src/services/helloasso.js';
import { normalizeHaStatus, isPaidLike,
         finalizePaidIfNoConflict,
         sendOrderAttestationIfNeeded,
         sendConflictEmail } from '../../../src/services/order-finalization.js';

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) { console.error('[sentinel] MONGO_URI/MONGODB_URI manquant'); process.exit(1); }

const sinceMin = Number((process.argv.find(a=>a.startsWith('--sinceMinutes='))||'').split('=')[1] || 180);

// ====== Housekeeping (holds & pending expirés) ======
const HOLD_EXPIRE_MIN = Number(process.env.CHECKOUT_HOLD_MIN || 5);
const PENDING_MAX_MIN = Number(process.env.PENDING_MAX_MIN || 5);

// Libère les sièges d'une commande annulée (holds posés avec meta.hold.orderId = order._id)
async function releaseSeatsForOrder(order) {
  const r = await Seat.updateMany(
    { seasonCode: order.seasonCode, venueSlug: order.venueSlug, status: 'busy', 'meta.hold.orderId': order._id },
    { $set: { status: 'available' }, $unset: { 'meta.hold': 1 } }
  );
  const released = r.modifiedCount ?? r.nModified ?? 0;
  console.log('[sentinel] releaseSeatsForOrder:', { orderId: order._id.toString(), released });
  return released;
}

async function releaseExpiredHolds({ seasonCode, venueSlug }) {
   const now = new Date();
   const r = await Seat.updateMany(
     { seasonCode, venueSlug, status: 'busy', 'meta.hold.until': { $lte: now } },
     { $set: { status: 'available' }, $unset: { 'meta.hold': 1 } }
   );
   console.log('[sentinel] releaseExpiredHolds:', { matched: r.matchedCount ?? r.n ?? 0, modified: r.modifiedCount ?? r.nModified ?? 0 });
 }
 
 async function cancelStalePendingAndRelease({ seasonCode, venueSlug }) {
   const cutoff = new Date(Date.now() - PENDING_MAX_MIN * 60 * 1000);
   const stale = await Order.find({
     seasonCode, venueSlug,
     status: 'pending',
     createdAt: { $lte: cutoff }
   }).lean();
   for (const o of stale) {
     await Order.updateOne({ _id: o._id, status: 'pending' }, { $set: { status: 'canceled' } });
     await releaseSeatsForOrder(o);
     console.log('[sentinel] canceled pending:', o._id.toString());

    }
 }


// ====== Résolution d’un contexte {seasonCode, venueSlug} ======
async function resolveCtx() {
  // On prend la saison/la salle de la commande la plus récente ; fallback sur l'env
  const recent = await Order.findOne({}).sort({ createdAt: -1 }).lean();
  const seasonCode = recent?.seasonCode || process.env.SEASON_CODE || null;
  const venueSlug  = recent?.venueSlug  || process.env.VENUE_SLUG  || null;
  return { seasonCode, venueSlug };
}

// ====== Runner unique : scan + housekeeping ======
async function runOnce() {
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });
  const since = new Date(Date.now() - sinceMin*60*1000);

  console.log('[sentinel] config:', {
    sinceMinutes: sinceMin,
    PENDING_MAX_MIN,
    CHECKOUT_HOLD_MIN: HOLD_EXPIRE_MIN
  });

  const list = await Order.find({
    status: { $in: ['pending'] },
    paymentProvider: 'helloasso',
    'paymentProviderMeta.checkoutIntentId': { $exists: true, $ne: null },
    createdAt: { $gte: since }
  }).sort({ createdAt: -1 }).lean();

  console.log(`[sentinel] scanning ${list.length} pending orders since ${since.toISOString()}`);

  for (const o of list) {
    const intent = o.paymentProviderMeta?.checkoutIntentId;
    if (!intent) continue;

    let raw;
    try { raw = await getCheckoutStatus(intent); }
    catch (e) { console.warn('[sentinel] getCheckoutStatus failed:', intent, e.message); raw = ''; }

    const status = normalizeHaStatus(raw);

    if (!isPaidLike(status)) {
      console.log(`[sentinel] keep pending ${o._id} → ${status||'(empty)'}`);
      continue;
    }

    // finalize (anti-conflit) via service
    const order = await Order.findById(o._id);
    if (!order) continue;
     const fin = await finalizePaidIfNoConflict(order);
      if (fin.ok) {
      console.log(`[sentinel] order ${o._id} → paid, seats booked: ${fin.booked}`);
      await sendOrderAttestationIfNeeded(order);
     } else {
      console.warn(`[sentinel] conflict — order ${o._id} marked failed`, fin.conflicts);
      await sendConflictEmail(order);
     }
    }
  // --- Housekeeping systématique (libérer holds expirés + annuler pending trop vieux)
  const ctx = await resolveCtx();
  if (ctx.seasonCode && ctx.venueSlug) {
    await releaseExpiredHolds(ctx);
    await cancelStalePendingAndRelease(ctx);
  } else {
    console.warn('[sentinel] housekeeping skipped (no season/venue context)');
  }

  await mongoose.disconnect();
  process.exit(0);
}

// Entrée
runOnce().catch(e => {
  console.error('[sentinel] fatal:', e);
  process.exit(1);
}); 
