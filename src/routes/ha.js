// src/routes/ha.js
import express from 'express';

import http from 'node:http';
import https from 'node:https';
import { URL as NodeURL } from 'node:url';

import { Order } from '../models/index.js';
import { getCheckoutStatus } from '../services/helloasso.js';
import { normalizeHaStatus, isPaidLike,
         finalizePaidIfNoConflict,
         sendOrderAttestationIfNeeded,
         sendConflictEmail } from '../services/order-finalization.js';

const router = express.Router();
const ORG_SLUG = process.env.HELLOASSO_ORG_SLUG || '';
const REPOST_URL = process.env.HELLOASSO_REPOST_URL || '';
const REPOST_TIMEOUT_MS = Number(process.env.HELLOASSO_REPOST_TIMEOUT_MS || 1000);


// ----- REPOST RAW (forward tel quel, avec fallback http/https) -----
function repostRawFromRequest(reqLike, sourceTag) {
try {
    if (!REPOST_URL) return;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REPOST_TIMEOUT_MS);

    const method = (reqLike.method || 'POST').toUpperCase();
    const origCT = reqLike.headers?.['content-type'] || reqLike.headers?.['Content-Type'] || '';
    let body = '';
    const headers = { 'X-Source': sourceTag };

    if (method === 'POST') {
      // Si on nous donne déjà une string brute -> on la renvoie telle quelle
      if (typeof reqLike.body === 'string') {
        body = reqLike.body;
        if (origCT) headers['Content-Type'] = origCT;
        else headers['Content-Type'] = 'application/octet-stream';
      } else if (Buffer.isBuffer(reqLike.body)) {
        body = reqLike.body; // Buffer OK
        if (origCT) headers['Content-Type'] = origCT;
        else headers['Content-Type'] = 'application/octet-stream';
      } else {
        // Objet déjà parsé -> on reconstruit en JSON
        try {
          body = JSON.stringify(reqLike.body ?? {});
        } catch (e) {
          body = typeof reqLike.body === 'object' ? String(reqLike.body) : '';
        }
        headers['Content-Type'] = origCT || 'application/json';
      }
    } else {
      // GET -> on reconstruit le form-urlencoded depuis query
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(reqLike.query || {})) {
        if (Array.isArray(v)) v.forEach(val => params.append(k, String(val)));
        else params.append(k, String(v));
      }
      body = params.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

     // fire-and-forget (on ne bloque pas le flux HA)
    if (typeof fetch === 'function') {
      // fire-and-forget, on n'attend pas la réponse
      fetch(REPOST_URL, { method: 'POST', headers, body })
        .catch(err => console.warn('[ha/repost-raw:fetch] failed:', err?.message || err));
      return; // on ne passe au fallback http/https QUE si fetch est absent
    }

    // 2) Fallback http/https natif
    const u = new NodeURL(REPOST_URL);
    const isHttps = u.protocol === 'https:';
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers: Object.assign({}, headers)
    };
    if (body != null && typeof body !== 'undefined') {
      opts.headers['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
    }
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

// ---- HTML neutre pour /ha/return
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
        <li><strong>L’attestation Billetterie</strong> envoyée par <em>billetterie@tbhc.fr</em>.</li>
      </ul>
      <div class="warn">
        <strong>Important&nbsp;:</strong>
        si vous recevez le reçu HelloAsso mais <em>pas</em> l’attestation Billetterie,
        vos places ne sont <strong>pas</strong> bloquées et nous procéderons au remboursement.
      </div>
    </div>`;
}




/**
 * GET /ha/return
 * STUB:   ?oid=<OrderId>&ci=<intentId>&stub=1&result=success|failure
 * HA:     ?checkoutIntentId=<id>&code=succeeded|canceled&orderId=<haOrderId>
 */
router.get('/return', (req, res) => {
  const q = req.query || {};
  console.log('[ha/return] query=', {
    oid: q.oid || null,
    ci: q.ci || q.checkoutIntentId || null,
    code: q.code || q.result || q.status || null,
    orderId: q.orderId || null
  });
  // 🧪 DEV STUB (optionnel) : si HELLOASSO_STUB=true ET stub=1, on finalise localement.
  try {
    const isStubDev = String(process.env.HELLOASSO_STUB || '').toLowerCase() === 'true';
    const doStub = isStubDev && String(q.stub || '0') === '1' && (q.oid || q.orderId);
    if (doStub) {
      (async () => {
        const orderId = String(q.oid || q.orderId);
        try {
          const o = await Order.findById(orderId);
          if (!o) return console.warn('[ha/return stub] order not found', orderId);
          const fin = await finalizePaidIfNoConflict(o);
          if (fin.ok) {
            await sendOrderAttestationIfNeeded(o);
            console.log('[ha/return stub] finalized & mailed', orderId);
          } else {
            console.warn('[ha/return stub] conflict', fin);
          }
        } catch (e) {
          console.error('[ha/return stub] error', e?.message || e);
        }
      })();
      // Affichage immédiat (on ne bloque pas sur la finalisation)
      return res.send(renderNeutral(String(q.oid || q.orderId), 'stub-dev'));
    }
  } catch {}

  const raw = q.status || q.code || q.result || '';
  const norm = normalizeHaStatus(raw);
  const label = (norm === 'failure' || norm === 'canceled') ? norm : '';
  const orderId = String(q.oid || q._id || q.orderId || q.checkoutIntentId || '—');

  // DEV/STUB : on finalise ici (fire-and-forget) au lieu d’attendre un webhook.
  (async () => {
    try {
      if (String(process.env.HELLOASSO_STUB||'').toLowerCase() === 'true') {
        const ord = await Order.findById(q.oid || q.orderId);
        if (ord) {
          // journalise le "retour" pour debug
          ord.paymentProvider = 'helloasso';
          ord.paymentProviderMeta = {
            ...(ord.paymentProviderMeta||{}),
            lastReturnAt: new Date(),
            lastReturnCode: norm || (raw || 'stub'),
            checkoutIntentId: ord.paymentProviderMeta?.checkoutIntentId || (q.ci || q.checkoutIntentId || null),
            stub: true
          };
          await ord.save();

          if (norm !== 'failure' && norm !== 'canceled') {
            const fin = await finalizePaidIfNoConflict(ord);   // ⚠️ N’altère PAS les seatId
            if (fin.ok) {
              try { await sendOrderAttestationIfNeeded(ord); } catch (e) {
                console.warn('[ha/return stub] mail send failed:', e?.message || e);
              }
            } else {
              console.warn('[ha/return stub] conflict', fin);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[ha/return stub] finalize failed:', e?.message || e);
    }
  })();

  return res.send(renderNeutral(orderId, label));

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
 * Source of truth. On forwarde le payload BRUT (fire-and-forget), puis on vérifie l'état via getCheckoutStatus.
 * Accepte tout Content-Type ; on conserve req._raw pour le REPOST.
 */
router.post('/webhook',
  // On essaye d'abord de capter le RAW ; si un json parser amont est passé, req.body sera un objet -> géré plus bas.
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
try {
    // 1) Capture RAW tolérante
    let rawTxt = '';
    if (Buffer.isBuffer(req.body)) {
      rawTxt = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      rawTxt = req.body;
    } else if (req.body && typeof req.body === 'object') {
      // déjà parsé par un middleware amont
      rawTxt = JSON.stringify(req.body);
    } else {
      rawTxt = '';
    }
    // 🔁 REPOST BRUT en non-bloquant (tel quel) en conservant le Content-Type si possible
    repostRawFromRequest(
      { method:'POST', body: rawTxt, headers: req.headers },
      'bts-ha-webhook'
    );

    // On tente de parser JSON (si applicable) pour piloter la logique locale
    let payload = null;
    try { if ((req.headers['content-type']||'').includes('json')) payload = JSON.parse(rawTxt); } catch {}
    if (payload?.postData?.contents) { try { payload = JSON.parse(payload.postData.contents); } catch {} }

    const data = payload?.data || {};
    const eventType = String(payload?.eventType || data?.eventType || '').toLowerCase();
    const orgSlug   = String(data?.organizationSlug || '').toLowerCase();

    // Filtre org
    if (ORG_SLUG && orgSlug && ORG_SLUG.toLowerCase() !== orgSlug) {
      console.warn('[ha/webhook] ignored (org mismatch)', { orgSlug, ORG_SLUG });
      return res.status(202).send('ignored');
    }

    // On ne TRAITE que Payment. Les autres events (Order, ...) sont ignorés (mais repostés).
    if (eventType !== 'payment') {
      return res.status(202).send('ignored-non-payment');
    }

    // Corrélation PRIORITAIRE par metadata.orderId (l’_id BTS passé à HelloAsso)
    const btsOrderId = String(payload?.metadata?.orderId || payload?.metadata?.orderNo || '').trim();
    if (!btsOrderId) {
      console.warn('[ha/webhook] missing metadata.orderId on Payment event');
      return res.status(202).send('ignored-no-bts-orderid');
    }
    let order = null;
    try { order = await Order.findById(btsOrderId); } catch { /* cast error */ }
    if (!order) {
      console.warn('[ha/webhook] order not found from metadata.orderId', { btsOrderId });
      return res.status(202).send('ignored-order-not-found');
    }

    // HelloAsso order id (utile pour rapprochements futurs)
    const haOrderId = String(data?.order?.id || '').trim() || null;

    // Vérification côté HA via l’intent : on utilise celui stocké en base ;
    // fallback sur data.checkoutIntentId si présent.
    const checkoutIntentIdFromPayload =
      String(data?.checkoutIntentId || '').trim() ||
      String(payload?.metadata?.checkoutIntentId || '').trim();

    const intentId =
      (order?.paymentProviderMeta?.checkoutIntentId ? String(order.paymentProviderMeta.checkoutIntentId) : '') ||
      checkoutIntentIdFromPayload;
      
    let statusFromApi = '';
    if (intentId) {
      try {
        const st = await getCheckoutStatus(intentId);
        statusFromApi = normalizeHaStatus(st);
      } catch (e) {
        console.warn('[ha/webhook] getCheckoutStatus failed:', e?.message || e);
      }
    }

    // Fallback très limité : on lit l’état brut du Payment (utile pour traces)
    const rawState = String(data?.state || data?.status || '').toLowerCase();
    const status   = statusFromApi || normalizeHaStatus(rawState);

    // Journalise + persiste les métadonnées HA (haOrderId, lastWebhook*)
    order.paymentProvider = 'helloasso';
    order.paymentProviderMeta = {
      ...(order.paymentProviderMeta || {}),
      name: 'helloasso',
      haOrderId: haOrderId || order?.paymentProviderMeta?.haOrderId || null,
      checkoutIntentId: order?.paymentProviderMeta?.checkoutIntentId || checkoutIntentIdFromPayload || null,      
      lastWebhookAt: new Date(),
      lastWebhookEvent: eventType,
      lastWebhookRawState: rawState
    };
    await order.save();
    
    if (isPaidLike(status)) {
      const fin = await finalizePaidIfNoConflict(order);
      if (fin.ok) {
        await sendOrderAttestationIfNeeded(order);
        return res.status(200).send('ok');
      } else {
        await sendConflictEmail(order);
        // on renvoie 200: le webhook a été traité (même s’il mène à failed)
        return res.status(200).send('conflict');
      }
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
