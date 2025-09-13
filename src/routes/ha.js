// src/routes/ha.js
import express from 'express';
import crypto from 'crypto';
import util from 'util';

import http from 'node:http';
import https from 'node:https';
import { URL as NodeURL } from 'node:url';

import { Order, Seat } from '../models/index.js';
import { getCheckoutStatus } from '../services/helloasso.js';
import { sendMail } from '../loaders/mailer.js';
import { renderOrderEmail, subjectForOrder } from '../services/mailer.js';

const router = express.Router();
const ORG_SLUG = process.env.HELLOASSO_ORG_SLUG || '';
const REPOST_URL = process.env.HELLOASSO_REPOST_URL || '';
const REPOST_TIMEOUT_MS = Number(process.env.HELLOASSO_REPOST_TIMEOUT_MS || 1000);

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
  if (raw === 'paid' || raw === 'payment_accepted' || raw === 'processed') return 'paid';
  if (raw.startsWith('authoriz')) return 'authorized';
  return raw;
}

// ----- REPOST RAW (forward tel quel, avec fallback http/https) -----
function repostRawFromRequest(req, sourceTag) {
  try {
    if (!REPOST_URL) {
      console.warn('[ha/repost-raw] skipped: HELLOASSO_REPOST_URL is empty');
      return;
    }
    // Prépare le body & headers
    let body = '';
    const headers = { 'X-Source': sourceTag };
    if (req.method === 'POST') {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      headers['Content-Type'] = 'application/json';
    } else {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query || {})) {
        if (Array.isArray(v)) v.forEach(val => params.append(k, String(val)));
        else params.append(k, String(v));
      }
      body = params.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    console.log('[ha/repost-raw] →', { url: REPOST_URL, via: (typeof fetch === 'function' ? 'fetch' : 'http/https'), ct: headers['Content-Type'], len: body.length });

    // 1) fetch si dispo (Node >=18)
    if (typeof fetch === 'function') {
      // fire-and-forget, on n'attend pas la réponse
      fetch(REPOST_URL, { method: 'POST', headers, body })
        .catch(err => console.warn('[ha/repost-raw:fetch] failed:', err?.message || err));
      return;
    }

    // 2) Fallback http/https natif
    const u = new NodeURL(REPOST_URL);
    const isHttps = u.protocol === 'https:';
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const client = isHttps ? https : http;
    const req2 = client.request(opts, (res2) => {
      // on consomme la réponse pour éviter les warnings, mais sans rien en faire
      res2.on('data', () => {});
      res2.on('end', () => {});
    });
    req2.on('error', (err) => console.warn('[ha/repost-raw:http] failed:', err?.message || err));
    if (REPOST_TIMEOUT_MS > 0) {
      req2.setTimeout(REPOST_TIMEOUT_MS, () => {
        console.warn('[ha/repost-raw:http] timeout');
        try { req2.destroy(new Error('timeout')); } catch {}
      });
    }
    req2.write(body);
    req2.end();
  } catch (e) {
    console.warn('[ha/repost-raw] failed:', e?.message || e);
  }
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
  return /^(paid|processed|authorized|authorized_ok|ok|success|succeeded)$/i.test(String(status || '').trim());
}

function renderNeutral(orderId, statusLabel) {
  const extra = statusLabel ? ` — statut: ${statusLabel}` : '';
  return `<!doctype html><meta charset="utf-8">
    <link rel="icon" href="/bts/static/img/favicon.ico">
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,'Noto Sans',sans-serif;
           margin:2rem;line-height:1.5}
      .card{max-width:720px;border:1px solid #eee;border-radius:12px;padding:24px}
      h1{font-size:1.25rem;margin:0 0 .5rem}
      .muted{color:#666}
      .warn{background:#FFF6E5;border:1px solid #F6C15C;padding:12px;border-radius:8px;margin-top:12px}
    </style>
    <div class="card">
      <h1>Traitement en cours…</h1>
      <p class="muted">Commande <strong>${orderId}</strong>${extra}</p>
      <p>Votre paiement a été pris en charge. Deux emails distincts vont vous parvenir&nbsp;:</p>
      <ul>
        <li><strong>Le reçu HelloAsso</strong> pour la transaction bancaire,</li>
        <li><strong>L’attestation d’abonnement</strong> envoyée par <em>billetterie@tbhc.fr</em>.</li>
      </ul>
      <div class="warn">
        <strong>Important&nbsp;:</strong>
        si vous recevez le reçu HelloAsso mais <em>pas</em> l’attestation d’abonnement,
        vos places ne sont <strong>pas</strong> bloquées et nous procéderons au remboursement.
      </div>
    </div>`;
}


/**
 * GET /ha/return
 * STUB:   ?oid=<OrderId>&ci=<intentId>&stub=1&result=success|failure
 * HA:     ?checkoutIntentId=<id>&code=succeeded|canceled&orderId=<haOrderId>
 */
router.get('/return', async (req, res) => {
console.log('Start return');    
  try {
    const q = req.query || {};
    // log concis pour diagnostiquer INT
    console.log('[ha/return] query=', {
      oid: q.oid || null,
      ci: q.ci || q.checkoutIntentId || null,
      code: q.code || q.result || q.status || null,
      orderId: q.orderId || null
    });

console.log('Before Raw repost');    
    // REPOST systématique du "payload" d'origine (ici: query string → POST x-www-form-urlencoded)
    repostRawFromRequest(req, 'bts-ha-return');

    const { oid, ci, stub, result, checkoutIntentId, code, orderId } = q;

    const inStub = isStub() || String(stub) === '1' || typeof result !== 'undefined';

    // Trouver la commande via tous les indices possibles
    const order = await findOrderFromQuery(q);

    if (!order) {
      // Même si aucune Order locale, le repost a déjà été effectué.
      return res.status(200).send(`<!doctype html><meta charset="utf-8">
        <link rel="icon" href="/bts/static/img/favicon.ico">
        <h1>Retour reçu</h1><p>Aucune commande locale correspondante.</p>`);
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
      // 🔽 normalise en toute circonstance (y compris si string vide)
      status = normalizeHaStatus(statusRaw, code);

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
      // passe paid, mais on affiche un message neutre
      order.status = 'paid';
      try { await order.save(); }
      catch (e) {
        if (e?.code === 11000) console.warn('[ha/return] duplicate paid (ignored):', e?.keyValue || e?.message);
        else throw e;
      }
      await markSeatsBooked(order);
      // email idempotent
      try {
        if (!order.paymentProviderMeta?.attestationSentAt) {
          const html    = await renderOrderEmail(order);
          const subject = subjectForOrder(order);
          await sendMail({ to: order.payerEmail, subject, html });
          order.paymentProviderMeta = { ...(order.paymentProviderMeta||{}), attestationSentAt: new Date() };
          await order.save();
        }
      } catch (e) { console.warn('sendMail failed:', e.message); }

      return res.send(renderNeutral(order._id, status));
    } else {
      // garder pending et rendre un message neutre
      if (order.status !== 'paid') {
        order.status = 'pending';
        await order.save();
      }

      return res.send(renderNeutral(order._id, status));
    }
    
      } catch (e) {
    console.error('[GET /ha/return] error:', e);
    res.status(500).send(`<!doctype html><meta charset="utf-8">
      <link rel="icon" href="/bts/static/img/favicon.ico">
      <h1>Erreur interne</h1>`);
  }
});

router.get('/back', (_req, res) => {
  res.send(`<!doctype html><meta charset="utf-8">
    <link rel="icon" href="/bts/static/img/favicon.ico">
    <h1>Paiement abandonné</h1><p>Vous pouvez reprendre votre commande ultérieurement.</p>`);
});

router.get('/error', (_req, res) => {
  res.status(400).send(`<!doctype html><meta charset="utf-8">
    <link rel="icon" href="/bts/static/img/favicon.ico">
    <h1>Erreur de paiement</h1><p>Une erreur est survenue. Réessayez plus tard.</p>`);
});


/**
 * POST /ha/webhook
 * Webhook HelloAsso (non signé côté club). On filtre par organizationSlug.
 * Payloads possibles (exemples fournis) :
 *  - eventType: "Payment" → data.order.id = <haOrderId>
 *  - eventType: "Order"   → data.id       = <haOrderId>
 */
router.post('/webhook', express.json({ type: '*/*' }), async (req, res) => {
  try {
    // Certains reverse/proxys peuvent encapsuler dans { postData: { contents: "<json>" } }
    let payload = req.body;
    if (payload?.postData?.contents) {
      try { payload = JSON.parse(payload.postData.contents); } catch { /* ignore */ }
    }
    const data = payload?.data || {};
    const eventType = String(payload?.eventType || data?.eventType || '').toLowerCase();
    const orgSlug   = String(data?.organizationSlug || '').toLowerCase();

    // Filtre org
    if (ORG_SLUG && orgSlug && ORG_SLUG.toLowerCase() !== orgSlug) {
      console.warn('[ha/webhook] ignored (org mismatch)', { orgSlug, ORG_SLUG });
      return res.status(202).send('ignored');
    }

    // Récup haOrderId selon le type d’event
    let haOrderId = null;
    if (eventType === 'payment') {
      haOrderId = data?.order?.id ?? null;
    } else if (eventType === 'order') {
      haOrderId = data?.id ?? null;
    }
    if (!haOrderId) {
      console.warn('[ha/webhook] no haOrderId in payload', { eventType });
      return res.status(202).send('ignored');
    }
    haOrderId = String(haOrderId);

    // Réconciliation : priorité au mapping déjà établi via /ha/return ; sinon fallback email+montant
    let order = await Order.findOne({ 'paymentProviderMeta.haOrderId': haOrderId });
    if (!order) {
      const payerEmail = String(data?.payer?.email || '').trim();
      const total = Number(
        (data?.amount && typeof data.amount === 'object' ? data.amount.total : data?.amount) || 0
      );
      if (payerEmail && total > 0) {
        const candidates = await Order.find({
          status: { $in: ['pending', 'paid'] },
          payerEmail: new RegExp(`^${payerEmail}$`, 'i'),
          totalCents: total
        }).sort({ createdAt: -1 }).limit(2).lean();
        if (candidates.length === 1) {
          order = await Order.findById(candidates[0]._id);
        }
      }
    }
    if (!order) {
      // Même si aucune Order locale, le repost a déjà été effectué.
      return res.status(200).send(`<!doctype html><meta charset="utf-8">
        <link rel="icon" href="/bts/static/img/favicon.ico">
        <h1>Retour reçu</h1><p>Aucune commande locale correspondante.</p>`);
    }

    // Màj méta + statut
    const rawState = String(data?.state || data?.status || '').toLowerCase();
    const status   = normalizeHaStatus(rawState);

    order.paymentProvider = 'helloasso';
    order.paymentProviderMeta = {
      ...(order.paymentProviderMeta || {}),
      name: 'helloasso',
      haOrderId,
      lastWebhookAt: new Date(),
      lastWebhookEvent: eventType,
      lastWebhookRawState: rawState
    };

    if (isPaidLike(status)) {
      order.status = 'paid';
      await order.save();
      await markSeatsBooked(order);
      try {
        const html = await renderOrderEmail(order);
        const subject = subjectForOrder(order);
        await sendMail({ to: order.payerEmail, subject, html });
      } catch (e) {
        console.warn('sendMail failed:', e.message);
      }
      return res.status(200).send('ok');
    } else {
      if (order.status !== 'paid') {
        order.status = 'pending';
        await order.save();
      }
      return res.status(200).send('pending');
    }
  } catch (e) {
    console.error('[ha/webhook] error:', e);
    return res.status(500).send('error');
  }
});


export default router;
