// src/routes/ha.js
import express from 'express';
import util from 'node:util';
import { Order, Seat } from '../models/index.js';
import { getCheckoutStatus } from '../services/helloasso.js';
import { sendMail } from '../loaders/mailer.js';
import { renderOrderEmail, subjectForOrder } from '../services/mailer.js';

const router = express.Router();

// helpers
const isVirtualZoneSeatId = sid => /^.+-Z\d{3,}$/i.test(String(sid||''));
const isOkCode = v => new Set(['success','succeeded','paid','ok']).has(String(v||'').toLowerCase());

// helper log sûr (objets profonds / non sérialisables)
const inspect = (v) => {
  try { return util.inspect(v, { depth: 6, maxArrayLength: 100, colors: false }); }
  catch { try { return JSON.stringify(v); } catch { return String(v); } }
};


// Normalise les statuts HA potentiels (string ou objet) et accepte un fallback depuis la query (?code=...)
function normalizeHaStatus(input, fallback) {
  // déballage d'objets potentiels
  let raw = input;
  if (raw && typeof raw === 'object') {
    raw =
      raw.status || raw.state || raw.code || raw.result || raw.paymentStatus ||
      (raw.data && (raw.data.status || raw.data.state || raw.data.code)) || '';
  }
  raw = String(raw || fallback || '').trim().toLowerCase();
  if (!raw) return '';
  // mapping simple vers une poignée de valeurs canoniques
  if (raw === 'payment_succeeded' || raw === 'success' || raw === 'succeeded' || raw === 'ok') return 'succeeded';
  if (raw === 'paid' || raw === 'payment_accepted') return 'paid';
  if (raw.startsWith('authoriz')) return 'authorized';
  return raw;
}



async function findOrderFromQuery(q) {
  const oid = q.oid || q._id; // flux STUB (DEV)
  const h   = q.h;            // éventuel token hash si tu l'ajoutes un jour
  const ci  = q.checkoutIntentId || q.ci; // SANDBOX / STUB
  const haOrderId = q.orderId;            // ID HelloAsso (numérique)

  // 1) ID local Mongo (si fourni)
  if (oid) {
    try {
      const o = await Order.findById(String(oid));
      if (o) return o;
    } catch { /* ignore cast */ }
  }
  // 2) Token hash (si utilisé)
  if (h) {
    const o = await Order.findOne({ 'paymentProviderMeta.tokenHash': String(h) });
    if (o) return o;
  }
  // 3) checkoutIntentId (SANDBOX/PROD)
  if (ci) {
    const o = await Order.findOne({ 'paymentProviderMeta.checkoutIntentId': String(ci) });
    if (o) return o;
  }
  // 4) HelloAsso orderId (si on l’a déjà enregistré dans meta, voir plus bas)
  if (haOrderId) {
    const o = await Order.findOne({ 'paymentProviderMeta.haOrderId': String(haOrderId) });
    if (o) return o;
  }
  return null;
}


// Helpers
const isStub = () => String(process.env.HELLOASSO_STUB || '').toLowerCase() === 'true';
const stubResultEnv = () => String(process.env.HELLOASSO_STUB_RESULT || 'success').toLowerCase();

// Marque en "booked" tous les SIÈGES réels de la commande (renew/subscription).
// - Ignore les lignes "zone" (ex: TBH7-Z001)
// - Idempotent: on remet "booked" même si l'état précédent n'était pas "available"
async function markSeatsBooked(order) {
  try {
    const lines = Array.isArray(order?.lines) ? order.lines : [];
    const realSeatIds = Array.from(new Set(
      lines.map(l => String(l.seatId || '').trim())
           // Ignore les pseudo-IDs de zone (ex: TBH7-Z001)
           .filter(s => s && !/-Z\d{3,}$/i.test(s))
    ));

    if (!realSeatIds.length) return;
    // ⚙️ Mise à jour inconditionnelle par seatId (sans filtre d'état) pour couvrir "Provisioned", "Held", etc.
    const r = await Seat.updateMany(
      { seasonCode: order.seasonCode, venueSlug: order.venueSlug, seatId: { $in: realSeatIds } },
      { $set: { status: 'booked' } },
      { runValidators: false }
    );
    console.log('[ha/return] seats → booked',
      { count: realSeatIds.length, matched: r.matchedCount ?? r.n ?? 0, modified: r.modifiedCount ?? r.nModified ?? 0, ids: realSeatIds });
    
  } catch (e) {
    console.warn('[ha/return] seat update failed:', e.message);
  }
}

function isPaidLike(status) {
  return /^(paid|authorized|authorized_ok|ok|success|succeeded)$/i.test(String(status || '').trim());
}

/**
 * GET /ha/return
 * STUB:   ?oid=<OrderId>&ci=<intentId>&stub=1&result=success|failure
 * HA:     ?checkoutIntentId=<id>&code=succeeded|canceled&orderId=<haOrderId>
 */
router.get('/ha/return', async (req, res) => {
  try {
    const q = req.query || {};
    // log concis pour diagnostiquer INT
    console.log('[ha/return] query=', {
      oid: q.oid || null,
      ci: q.ci || q.checkoutIntentId || null,
      code: q.code || q.result || q.status || null,
      orderId: q.orderId || null
    });
    const { oid, ci, stub, result, checkoutIntentId, code, orderId } = q;

    const inStub = isStub() || String(stub) === '1' || typeof result !== 'undefined';

    // Trouver la commande via tous les indices possibles
    const order = await findOrderFromQuery(q);

    if (!order) {
      return res.status(404).send(`<!doctype html><meta charset="utf-8">
        <link rel="icon" href="/bts/static/img/favicon.ico">
        <h1>Order not found</h1>`);
    }

    console.log('[ha/return] order found', {
      orderId: String(order._id),
      status: order.status,
      meta: order.paymentProviderMeta
    });

if (order.status === 'paid') {
      return res.send(`<!doctype html><meta charset="utf-8">
        <link rel="icon" href="/bts/static/img/favicon.ico">
        <h1>Paiement déjà confirmé ✅</h1><p>Commande ${order._id}</p>`);
    }

    let status;

    if (inStub) {
      const desired = String(result || stubResultEnv());
      status = (desired === 'success') ? 'success' : 'failure';

      // trace minimale “provider”
      order.paymentProvider = 'helloasso';
      order.paymentProviderMeta = {
        ...(order.paymentProviderMeta || {}),
        name: 'stub',
        checkoutIntentId: ci || checkoutIntentId || `stub-${Date.now()}`,
        stubResult: status
      };
    } else {
      // PROD/SANDBOX: verify via HelloAsso
      const resolvedIntentId = checkoutIntentId || ci;
      if (!resolvedIntentId) {
        return res.status(400).send(`<!doctype html><meta charset="utf-8">
          <link rel="icon" href="/bts/static/img/favicon.ico">
          <h1>Bad Request</h1><p>checkoutIntentId manquant</p>`);
      }
      console.log('[ha/return] resolvedIntentId=', resolvedIntentId);
      let statusRaw;

      try {
        // Peut renvoyer une string OU un objet → on normalise plus bas
        statusRaw = await getCheckoutStatus(resolvedIntentId);
        console.log('[ha/return] getCheckoutStatus raw type=', typeof statusRaw, 'value=', inspect(statusRaw));
      } catch (e) {
        console.error('[ha/return] getCheckoutIntent failed:', e.message || e);
        return res.status(500).send(`<!doctype html><meta charset="utf-8">
          <link rel="icon" href="/bts/static/img/favicon.ico">
          <h1>Erreur interne</h1>`);
      }

      order.paymentProvider = 'helloasso';
      order.paymentProviderMeta = {
        ...(order.paymentProviderMeta || {}),
        name: 'helloasso',
        haOrderId: orderId || order.paymentProviderMeta?.haOrderId || null,
        checkoutIntentId: resolvedIntentId,
        code: code || null,
        lastReturnAt: new Date(),
        lastReturnCode: code || (typeof statusRaw === 'string' ? statusRaw : (statusRaw?.status || statusRaw?.state || '')),
        lastStatusRawType: typeof statusRaw,
        lastStatusRaw: (() => { try { return JSON.stringify(statusRaw); } catch { return String(statusRaw); } })()
      };
    }

    if (isPaidLike(status)) {
      order.status = 'paid';
      await order.save();
      await markSeatsBooked(order);
      // --- EMAIL ---
      try {
        const html    = await renderOrderEmail(order);
        const subject = subjectForOrder(order);
        await sendMail({ to: order.payerEmail, subject, html });
      } catch (e) {
        console.warn('sendMail failed:', e.message);
      }

      return res.send(`<!doctype html><meta charset="utf-8">
        <link rel="icon" href="/bts/static/img/favicon.ico">
        <h1>Paiement confirmé ✅</h1><p>Commande ${order._id}</p>`);

    } else {
      order.status = 'failed';
      await order.save();
      return res.send(`<!doctype html><meta charset="utf-8">
        <link rel="icon" href="/bts/static/img/favicon.ico">
        <h1>Paiement non confirmé ❌</h1><p>Commande ${order._id} — statut: ${status || code || 'unknown'}</p>`);
      }
  } catch (e) {
    console.error('[GET /ha/return] error:', e);
    res.status(500).send(`<!doctype html><meta charset="utf-8">
      <link rel="icon" href="/bts/static/img/favicon.ico">
      <h1>Erreur interne</h1>`);
  }
});

router.get('/ha/back', (_req, res) => {
  res.send(`<!doctype html><meta charset="utf-8">
    <link rel="icon" href="/bts/static/img/favicon.ico">
    <h1>Paiement abandonné</h1><p>Vous pouvez reprendre votre commande ultérieurement.</p>`);
});

router.get('/ha/error', (_req, res) => {
  res.status(400).send(`<!doctype html><meta charset="utf-8">
    <link rel="icon" href="/bts/static/img/favicon.ico">
    <h1>Erreur de paiement</h1><p>Une erreur est survenue. Réessayez plus tard.</p>`);
});

export default router;
