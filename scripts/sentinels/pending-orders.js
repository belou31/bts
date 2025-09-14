// scripts/sentinels/pending-orders.js

// Parcourt les orders HelloAsso en pending récents, vérifie le statut et finalise si paid.
// Usage (cron/PM2): node scripts/sentinels/pending-orders.js [--sinceMinutes=180]
// (PM2 cron) : voir README ou ecosystem.config.js

import 'dotenv/config';

import mongoose from 'mongoose';
import { Order } from '../../src/models/Order.js';
import { Seat }  from '../../src/models/Seat.js';
import { renderOrderEmail, subjectForOrder } from '../../src/services/mailer.js';
import { sendMail } from '../../src/loaders/mailer.js';
import { getCheckoutStatus } from '../../src/services/helloasso.js';

const uri = process.env.MONGO_URI;
if (!uri) { console.error('[sentinel] MONGO_URI manquant'); process.exit(1); }

const sinceMin = Number((process.argv.find(a=>a.startsWith('--sinceMinutes='))||'').split('=')[1] || 180);
const isPaidLike = s => /^(paid|processed|authorized|authorized_ok|ok|success|succeeded)$/i.test(String(s||''));
const isVirtualZoneSeatId = sid => /^.+-Z\d{3,}$/i.test(String(sid||''));

async function markSeatsBooked(order) {
  const seatIds = Array.from(new Set(
    (order.lines||[]).map(l => String(l.seatId||'').trim()).filter(s => s && !isVirtualZoneSeatId(s))
  ));
  if (!seatIds.length) return 0;
  const r = await Seat.updateMany(
    { seasonCode: order.seasonCode, venueSlug: order.venueSlug, seatId: { $in: seatIds } },
    { $set: { status: 'booked' }, $unset: { 'meta.hold': 1 } },
    { runValidators: false }
  );
  return r.modifiedCount ?? r.nModified ?? 0;
}

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

    const status = (s => {
      if (s && typeof s === 'object') s = s.status || s.state || s.code || '';
      s = String(s||'').toLowerCase();
      if (s === 'payment_succeeded' || s === 'success' || s === 'succeeded' || s === 'ok') return 'succeeded';
      if (s === 'paid' || s === 'processed' || s === 'payment_accepted') return 'paid';
      if (s.startsWith('authoriz')) return 'authorized';
      return s;
    })(raw);

    if (!isPaidLike(status)) {
      console.log(`[sentinel] keep pending ${o._id} → ${status||'(empty)'}`);
      continue;
    }

    // finalize
    const order = await Order.findById(o._id);
    if (!order) continue;
    order.status = 'paid';
    try { await order.save(); }
    catch (e) {
      if (e?.code === 11000) console.warn('[sentinel] duplicate paid (ignored):', e?.keyValue || e?.message);
      else throw e;
    }
    const booked = await markSeatsBooked(order);
    console.log(`[sentinel] order ${o._id} → paid, seats booked: ${booked}`);

    try {
      if (!order.paymentProviderMeta?.attestationSentAt) {
        const html = await renderOrderEmail(order);
        const subject = subjectForOrder(order);
        await sendMail({ to: order.payerEmail, subject, html });
        order.paymentProviderMeta = { ...(order.paymentProviderMeta||{}), attestationSentAt: new Date() };
        await order.save();
        console.log(`[sentinel] attestation sent to ${order.payerEmail}`);
      }
    } catch (e) { console.warn('[sentinel] sendMail failed:', e.message); }
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


