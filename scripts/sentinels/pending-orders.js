// scripts/sentinels/pending-orders.js
// Parcourt les orders HelloAsso en pending récents, vérifie le statut et finalise si paid.
// Usage (cron/PM2): node scripts/sentinels/pending-orders.js [--sinceMinutes=180]

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { Order } from '../../src/models/Order.js';
import { Seat }  from '../../src/models/Seat.js';
import { getCheckoutStatus } from '../../src/services/helloasso.js';
import { renderOrderEmail, subjectForOrder } from '../../src/services/mailer.js';
import { sendMail } from '../../src/loaders/mailer.js';

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
    { $set: { status: 'booked' } },
    { runValidators: false }
  );
  return r.modifiedCount ?? r.nModified ?? 0;
}

(async () => {
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });
  const since = new Date(Date.now() - sinceMin*60*1000);

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
    catch (e) { console.warn('[sentinel] getCheckoutStatus failed:', intent, e.message); continue; }

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

  await mongoose.disconnect();
  process.exit(0);
})();
