// src/routes/pay.js
import express from 'express';

import http from 'node:http';
import https from 'node:https';
import { URL as NodeURL } from 'node:url';

import { Order } from '../models/index.js';
import { getCheckoutStatus, currentPaymentProviderId, currentPaymentProviderLabel } from '../services/payments/index.js';
import { normalizePaymentStatus, isPaidLike, isRefundedLike,
         finalizePaidIfNoConflict,
         sendOrderAttestationIfNeeded,
         sendConflictEmail,
         ensureTicketsForEventOrder } from '../services/order-finalization.js';
import { buildTicketsPdfBuffer } from '../services/tickets-pdf.js';

const router = express.Router();
const PAYMENT_PROVIDER_ID = currentPaymentProviderId();
const PAYMENT_PROVIDER_LABEL = currentPaymentProviderLabel();
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
        .catch(err => console.warn('[pay/repost-raw:fetch] failed:', err?.message || err));
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
    req2.on('error', (err) => console.warn('[pay/repost-raw:http] failed:', err?.message || err));
    if (REPOST_TIMEOUT_MS > 0) {
      req2.setTimeout(REPOST_TIMEOUT_MS, () => {
        console.warn('[pay/repost-raw:http] timeout');
        try { req2.destroy(new Error('timeout')); } catch {}
      });
    }
    req2.write(body);
    req2.end();
  } catch (e) {
    console.warn('[pay/repost-raw] failed:', e?.message || e);
  }
}

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

function pickFirstParam(value) {
  if (Array.isArray(value)) {
    return pickFirstParam(value[0]);
  }
  if (typeof value === 'string') {
    const idx = value.indexOf(',');
    return idx >= 0 ? value.slice(0, idx) : value;
  }
  return value;
}

function buildRefreshHref({ orderId, intentId, providerOrderId }) {
  const params = new URLSearchParams();
  if (orderId) params.set('oid', orderId);
  if (intentId) params.set('ci', intentId);
  if (providerOrderId) params.set('orderId', providerOrderId);
  const query = params.toString();
  return query ? `/pay/return?${query}` : '/pay/return';
}

function renderPaymentReturn({
  state,
  orderId,
  providerStatus,
  finalizeInfo,
  refreshHref,
  warnings = [],
  errors = [],
  intentId,
  providerLabel,
  providerOrderId,
  providerPaymentId,
  payerEmail,
  contactEmail,
  homeUrl,
  ticketsUrl
}) {
  const safeOrderId = escapeHtml(orderId || '—');
  const safeProviderStatus = providerStatus ? escapeHtml(providerStatus) : '';
  const safeProviderLabel = providerLabel ? escapeHtml(providerLabel) : 'prestataire';
  const safeIntentId = intentId ? escapeHtml(intentId) : '';
  const safeProviderPaymentId = providerPaymentId ? escapeHtml(providerPaymentId) : '';
  const safeProviderOrderId = providerOrderId ? escapeHtml(providerOrderId) : '';
  const contactRaw = contactEmail || 'billetterie@tbhc.fr';
  const mailMatch = contactRaw.match(/<([^>]+)>/);
  const mailTarget = mailMatch ? mailMatch[1] : contactRaw;
  const safeContactEmail = escapeHtml(contactRaw);
  const safeContactHref = `mailto:${escapeHtml(mailTarget)}`;
  const safeHomeUrl = escapeHtml(homeUrl || '/');
  const safeTicketsUrl = ticketsUrl ? escapeHtml(ticketsUrl) : '';
  const cardClass = state === 'success' ? 'success' : state === 'failure' ? 'failure' : 'pending';

  let title;
  let intro;
  const safeEmail = escapeHtml(payerEmail || '');
  const supportLine = `<p class="muted">En cas de problème, écrivez à <a href="${safeContactHref}">${safeContactEmail}</a>.</p>`;
  if (state === 'success') {
    title = 'Paiement confirmé ✅';
    intro = `
      <p>Bravo&nbsp;! Le paiement a été validé et vos places sont désormais <strong>confirmées</strong>.</p>
      <p class="muted">Vous allez recevoir un email de confirmation accompagné de vos billets${safeEmail ? ` à l’adresse <strong>${safeEmail}</strong>` : ''}.</p>
      ${safeTicketsUrl ? `<p>Vous pouvez télécharger vos billets directement ici&nbsp;: <a href="${safeTicketsUrl}">billets-${safeOrderId}.pdf</a></p>` : ''}
      ${supportLine}
    `;
  } else if (state === 'failure') {
    title = 'Paiement non confirmé ❌';
    intro = `
      <p>Le prestataire de paiement signale un échec ou une annulation. Aucun siège n’a été réservé.</p>
      <p class="muted">Si vous pensez qu’il s’agit d’une erreur, contactez notre équipe en précisant la référence ci-dessous.</p>
      ${supportLine}
    `;
  } else {
    title = 'Paiement en cours de validation…';
    intro = `
      <p>Nous vérifions la confirmation auprès du prestataire. Cette étape prend souvent quelques secondes.</p>
      <p class="muted">La page se rafraîchira automatiquement, mais vous pouvez également le faire manuellement.</p>
      ${supportLine}
    `;
  }

  const detailItems = [];
  if (safeProviderStatus) detailItems.push(`<li>Statut ${safeProviderLabel} : <strong>${safeProviderStatus}</strong></li>`);
  const shouldShowIntent = !(state === 'success' && safeProviderStatus === 'paid');
  if (safeIntentId && shouldShowIntent) {
    detailItems.push(`<li>${safeProviderLabel} — Demande : <code>${safeIntentId}</code></li>`);
  }
  if (safeProviderOrderId) detailItems.push(`<li>${safeProviderLabel} — Commande : <code>${safeProviderOrderId}</code></li>`);
  if (safeProviderPaymentId) detailItems.push(`<li>${safeProviderLabel} — Paiement : <code>${safeProviderPaymentId}</code></li>`);
  if (finalizeInfo && typeof finalizeInfo === 'object') {
    if (finalizeInfo.ok) {
      detailItems.push(`<li>Finalisation billets : ${finalizeInfo.alreadyFinalized ? 'déjà effectuée' : 'succès'}</li>`);
    } else {
      detailItems.push(`<li>Finalisation billets : en attente (vérification manuelle requise)</li>`);
    }
  }

  const detailsHtml = detailItems.length
    ? `<div class="details"><h2>Détails</h2><ul>${detailItems.join('')}</ul></div>`
    : '';

  const warningsHtml = warnings.length
    ? `<div class="note warn"><strong>À vérifier&nbsp;:</strong><ul>${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
    : '';

  const errorsHtml = errors.length
    ? `<div class="note error"><strong>Incident&nbsp;:</strong><ul>${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`
    : '';

  const safeRefresh = escapeHtml(refreshHref || '/pay/return');

  return `<!doctype html>
  <meta charset="utf-8">
  <link rel="icon" href="/bts/static/img/favicon.ico">
  <style>
    :root {
      color-scheme: light dark;
      font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,'Noto Sans',sans-serif;
    }
    body { margin: 2rem; line-height: 1.6; }
    .card { max-width: 720px; border: 1px solid #e5e7eb; border-radius: 16px; padding: 28px; }
    .card.success { border-left: 6px solid #22c55e; }
    .card.pending { border-left: 6px solid #f59e0b; }
    .card.failure { border-left: 6px solid #ef4444; }
    h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
    h2 { font-size: 1.1rem; margin-top: 1.2rem; }
    .muted { color: #6b7280; }
    ul { padding-left: 1.2rem; }
    .note { margin-top: 1rem; padding: 0.9rem 1rem; border-radius: 12px; }
    .note.warn { background: #fef3c7; border: 1px solid #fbbf24; }
    .note.error { background: #fee2e2; border: 1px solid #f87171; }
    .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.5rem; }
    button.refresh {
      appearance: none;
      border: 0;
      background: #2563eb;
      color: white;
      padding: 0.6rem 1.1rem;
      border-radius: 999px;
      font-size: 0.95rem;
      cursor: pointer;
    }
    button.refresh:hover { background: #1d4ed8; }
    a.secondary {
      color: #2563eb;
      text-decoration: none;
      align-self: center;
    }
    a.secondary:hover { text-decoration: underline; }
  </style>
  <div class="card ${cardClass}">
    <h1>${title}</h1>
    <p class="muted">Commande&nbsp;: <strong>${safeOrderId}</strong></p>
    ${intro}
    ${detailsHtml}
    ${warningsHtml}
    ${errorsHtml}
    <div class="actions">
      <button type="button" class="refresh" data-refresh="${safeRefresh}">Actualiser le statut</button>
      <a class="secondary" href="${safeHomeUrl}">Retour au site</a>
    </div>
  </div>
  <script>
  (function() {
    function nextUrl(base) {
      const sep = base.includes('?') ? '&' : '?';
      return base + sep + 'ts=' + Date.now();
    }
    function triggerRefresh() {
      const btn = document.querySelector('[data-refresh]');
      if (!btn) return;
      const base = btn.getAttribute('data-refresh') || '/pay/return';
      window.location.href = nextUrl(base);
    }
    document.querySelectorAll('[data-refresh]').forEach(btn => {
      btn.addEventListener('click', function(ev) {
        ev.preventDefault();
        triggerRefresh();
      });
    });
    ${state === 'pending' ? 'setTimeout(triggerRefresh, 8000);' : ''}
  })();
  </script>`;
}



/**
 * GET /pay/return
 * STUB:   ?oid=<OrderId>&ci=<intentId>&stub=1&result=success|failure
 * PSP:    ?checkoutIntentId=<id>&code=succeeded|canceled&orderId=<providerOrderId>
 */
router.get('/return', async (req, res) => {
  const q = req.query || {};
  console.log('[pay/return] query=', {
    oid: q.oid || null,
    ci: q.ci || q.checkoutIntentId || null,
    code: q.code || q.result || q.status || null,
    orderId: q.orderId || null,
    paymentId: q.paymentId || q.providerPaymentId || null
  });
  const rawOrderId = pickFirstParam(q.oid ?? '');
  const orderIdParam = rawOrderId ? String(rawOrderId).trim() : '';
  const rawProviderOrder = pickFirstParam(q.orderId ?? q.providerOrderId ?? '');
  const providerOrderIdParam = rawProviderOrder ? String(rawProviderOrder).trim() : '';
  const rawProviderPayment = pickFirstParam(q.paymentId ?? q.providerPaymentId ?? '');
  const providerPaymentIdParam = rawProviderPayment ? String(rawProviderPayment).trim() : '';
  const rawIntent = pickFirstParam(q.ci ?? q.checkoutIntentId ?? '');
  const intentParam = rawIntent ? String(rawIntent).trim() : '';
  const rawStatus = pickFirstParam(q.status ?? q.code ?? q.result ?? '');
  const statusFromQuery = normalizePaymentStatus(rawStatus);
  const warnings = [];
  const errors = [];
  let state = 'pending';
  let finalizeInfo = null;
  const homeUrl = process.env.PAY_RETURN_HOME_URL || process.env.EVENT_RETURN_HOME_URL || process.env.APP_URL || '/';
  const contactEmail = process.env.PAY_CONTACT_EMAIL || process.env.CONTACT_EMAIL || process.env.SUPPORT_EMAIL || process.env.FROM_EMAIL || 'billetterie@tbhc.fr';

  let order = null;
  let orderLookupWarning = '';
  if (orderIdParam) {
    try {
      order = await Order.findById(orderIdParam);
      if (!order) orderLookupWarning = "Commande introuvable. Si le paiement est confirmé, contactez l’assistance.";
    } catch (e) {
      console.warn('[pay/return] lookup failed:', e?.message || e);
      orderLookupWarning = "Commande introuvable. Si le paiement est confirmé, contactez l’assistance.";
    }
  }

  let checkoutIntentId = intentParam || null;
  if (!checkoutIntentId && order?.paymentProviderMeta?.checkoutIntentId) {
    checkoutIntentId = String(order.paymentProviderMeta.checkoutIntentId);
  }
  if (!order && providerOrderIdParam) {
    try {
      order = await Order.findOne({ 'paymentProviderMeta.providerOrderId': providerOrderIdParam });
    } catch (err) {
      console.warn('[pay/return] provider order lookup failed:', err?.message || err);
    }
  }
  if (!order && checkoutIntentId) {
    try {
      order = await Order.findOne({ 'paymentProviderMeta.checkoutIntentId': checkoutIntentId });
    } catch (err) {
      console.warn('[pay/return] intent lookup failed:', err?.message || err);
    }
  }
  if (!order && orderLookupWarning) {
    warnings.push(orderLookupWarning);
  }
  let providerStatus = statusFromQuery;
  const refreshHref = buildRefreshHref({
    orderId: order?.id ? String(order.id) : orderIdParam,
    intentId: checkoutIntentId,
    providerOrderId: providerOrderIdParam || order?.paymentProviderMeta?.providerOrderId || null
  });

  if (checkoutIntentId) {
    try {
      const statusFromProvider = await getCheckoutStatus(checkoutIntentId);
      const normalized = normalizePaymentStatus(statusFromProvider);
      if (normalized) providerStatus = normalized;
    } catch (err) {
      console.warn('[pay/return] getCheckoutStatus failed:', err?.message || err);
      warnings.push('Le prestataire n’a pas encore confirmé le paiement. Veuillez réessayer dans quelques secondes.');
    }
  }
  if (!providerStatus && statusFromQuery) {
    providerStatus = statusFromQuery;
  }
  if (/^(refunded)$/i.test(providerStatus || '')) {
    state = 'failure';
    warnings.push('Le paiement a été remboursé. Les places associées seront libérées sous peu.');
  } else if (/^(failure|failed|canceled)$/i.test(providerStatus || '')) {
    state = 'failure';
    warnings.push('Le prestataire a signalé un échec : aucune place n’a été confirmée.');
  }

  if (order) {
    order.paymentProvider = PAYMENT_PROVIDER_ID;
  }

  if (order) {
    const meta = { ...(order.paymentProviderMeta || {}) };
    meta.lastReturnAt = new Date();
    if (statusFromQuery || rawStatus) {
      meta.lastReturnCode = statusFromQuery || String(rawStatus);
    }
    if (checkoutIntentId) meta.checkoutIntentId = checkoutIntentId;
    if (providerOrderIdParam) {
      meta.haOrderId = providerOrderIdParam;
      if (!meta.providerOrderId) meta.providerOrderId = providerOrderIdParam;
    }
    if (providerPaymentIdParam) {
      meta.lastReturnProviderPaymentId = providerPaymentIdParam;
      if (!meta.providerPaymentId) meta.providerPaymentId = providerPaymentIdParam;
    }
    if (providerStatus) {
      meta.lastReturnProviderStatus = providerStatus;
      meta.lastStatusSource = 'return';
      meta.lastStatusFromReturn = providerStatus;
      meta.lastStatusCheckedAt = new Date();
    }
    order.paymentProviderMeta = meta;
    order.paymentProvider = PAYMENT_PROVIDER_ID;
  }

  if (order && isPaidLike(providerStatus)) {
    try {
      finalizeInfo = await finalizePaidIfNoConflict(order);
      if (finalizeInfo.ok) {
        state = 'success';
        if (!finalizeInfo.alreadyFinalized) {
          const meta = { ...(order.paymentProviderMeta || {}) };
          meta.lastReturnFinalizeAt = new Date();
          meta.lastReturnFinalizeSource = 'return';
          order.paymentProviderMeta = meta;
          order.markModified?.('paymentProviderMeta');
          try {
            await sendOrderAttestationIfNeeded(order, { source: 'return' });
          } catch (err) {
            console.warn('[pay/return] mail send failed:', err?.message || err);
            warnings.push('Le courriel de confirmation n’a pas pu être envoyé automatiquement.');
          }
        }
      } else {
        warnings.push("Le paiement est confirmé, mais la finalisation de vos sièges nécessite une intervention manuelle.");
      }
    } catch (err) {
      console.error('[pay/return] finalize error:', err?.message || err);
      errors.push('Erreur lors de la finalisation de la commande. Contactez le support si le problème persiste.');
    }
  }

  if (order) {
    try {
      await order.save();
    } catch (err) {
      console.warn('[pay/return] order save failed:', err?.message || err);
    }
  }

  const paymentSnapshot = order?.paymentProviderMeta?.lastPaymentSnapshot || null;
  const paymentHistory = Array.isArray(order?.paymentProviderMeta?.paymentHistory)
    ? order.paymentProviderMeta.paymentHistory
    : [];
  const lastPaymentFromHistory = paymentHistory.length ? paymentHistory[paymentHistory.length - 1] : null;
  const providerPaymentId = providerPaymentIdParam ||
    paymentSnapshot?.paymentId ||
    lastPaymentFromHistory?.paymentId ||
    order?.paymentProviderMeta?.lastReturnProviderPaymentId ||
    order?.paymentProviderMeta?.providerPaymentId ||
    '';

  const html = renderPaymentReturn({
    state,
    orderId: order ? order.id.toString() : (orderIdParam || '—'),
    providerStatus,
    finalizeInfo,
    refreshHref,
    warnings,
    errors,
    intentId: checkoutIntentId,
    providerLabel: PAYMENT_PROVIDER_LABEL,
    providerOrderId: providerOrderIdParam ||
      order?.paymentProviderMeta?.providerOrderId ||
      order?.paymentProviderMeta?.haOrderId ||
      '',
    providerPaymentId,
    payerEmail: order?.payerEmail || order?.paymentProviderMeta?.payerEmail || order?.paymentProviderMeta?.lastPayerEmail || '',
    contactEmail,
    homeUrl,
    ticketsUrl: (state === 'success' && order?.id) ? `/pay/tickets/${encodeURIComponent(String(order.id))}.pdf` : ''
  });
  return res.send(html);
});


// Billets PDF accessibles depuis la page de retour (commande payée uniquement)
router.get('/tickets/:orderId.pdf', async (req, res) => {
  const orderId = (req.params.orderId || '').trim();
  if (!orderId) return res.status(404).send('missing order');
  let order = null;
  try {
    order = await Order.findById(orderId);
  } catch {
    return res.status(404).send('order not found');
  }
  if (!order) return res.status(404).send('order not found');
  if (!isPaidLike(order.status)) return res.status(403).send('paiement non confirmé');

  try {
    await ensureTicketsForEventOrder(order);
  } catch (err) {
    console.warn('[pay/tickets] ensureTicketsForEventOrder failed:', err?.message || err);
  }

  const tickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  if (!tickets.length) return res.status(404).send('tickets indisponibles');

  try {
    const pdf = await buildTicketsPdfBuffer(order);
    if (!pdf || !pdf.length) return res.status(404).send('tickets indisponibles');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="billets-${orderId}.pdf"`);
    return res.send(pdf);
  } catch (err) {
    console.error('[pay/tickets] pdf failed:', err?.message || err);
    return res.status(500).send('pdf error');
  }
});


router.get('/back', (_req, res) => {
  res.send(`<!doctype html><meta charset="utf-8">
    <link rel="icon" href="/bts/static/img/favicon.ico">
    <h1>Paiement abandonné</h1>
    <p>Aucun débit n’a été effectué et vos places restent disponibles tant que la commande n’est pas confirmée.</p>
    <p><a href="/">Revenir à la billetterie</a></p>`);
});

router.get('/error', (_req, res) => {
  res.status(400).send(`<!doctype html><meta charset="utf-8">
    <link rel="icon" href="/bts/static/img/favicon.ico">
    <h1>Erreur de paiement</h1><p>Une erreur est survenue. Réessayez plus tard.</p>`);
});


/**
 * POST /pay/webhook
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
      console.warn('[pay/webhook] ignored (org mismatch)', { orgSlug, ORG_SLUG });
      return res.status(202).send('ignored');
    }

    // On ne TRAITE que Payment. Les autres events (Order, ...) sont ignorés (mais repostés).
    if (eventType !== 'payment') {
      return res.status(202).send('ignored-non-payment');
    }

    // Corrélation PRIORITAIRE par metadata/custom_id (l’_id BTS passé à PSP)
    const btsOrderId = String(
      payload?.metadata?.orderId ||
      payload?.metadata?.orderNo ||
      data?.metadata?.orderId ||
      data?.metadata?.orderNo ||
      data?.custom_id ||
      payload?.custom_id ||
      ''
    ).trim();
    if (!btsOrderId) {
      console.warn('[pay/webhook] missing order id metadata on payment event');
      return res.status(202).send('ignored-no-bts-orderid');
    }
    let order = null;
    try { order = await Order.findById(btsOrderId); } catch { /* cast error */ }
    if (!order) {
      console.warn('[pay/webhook] order not found from metadata.orderId', { btsOrderId });
      return res.status(202).send('ignored-order-not-found');
    }

    // Provider order id (utile pour rapprochements futurs)
    const providerOrderId = String(
      data?.order?.id ||
      data?.transaction_code ||
      data?.transaction_id ||
      payload?.transaction_id ||
      ''
    ).trim() || null;

    // Vérification côté HA via l’intent : on utilise celui stocké en base ;
    // fallback sur data.checkoutIntentId si présent.
    const checkoutIntentIdFromPayload =
      String(data?.checkoutIntentId || '').trim() ||
      String(payload?.metadata?.checkoutIntentId || '').trim() ||
      String(data?.checkout_reference || '').trim() ||
      String(payload?.checkout_reference || '').trim();

    const intentId =
      (order?.paymentProviderMeta?.checkoutIntentId ? String(order.paymentProviderMeta.checkoutIntentId) : '') ||
      (order?.paymentProviderMeta?.checkoutReference ? String(order.paymentProviderMeta.checkoutReference) : '') ||
      checkoutIntentIdFromPayload;
      
    let statusFromApi = '';
    if (intentId) {
      try {
        const st = await getCheckoutStatus(intentId);
        statusFromApi = normalizePaymentStatus(st);
      } catch (e) {
        console.warn('[pay/webhook] getCheckoutStatus failed:', e?.message || e);
      }
    }

    // Fallback très limité : on lit l’état brut du Payment (utile pour traces)
    const rawState = String(data?.state || data?.status || '').toLowerCase();
    const status   = statusFromApi || normalizePaymentStatus(rawState);

    // Journalise + persiste les métadonnées HA (haOrderId, lastWebhook*)
    order.paymentProvider = PAYMENT_PROVIDER_ID;
    const meta = { ...(order.paymentProviderMeta || {}) };
    const now = new Date();
    meta.name = PAYMENT_PROVIDER_ID;
    meta.haOrderId = providerOrderId || meta.haOrderId || null;
    if (providerOrderId) meta.providerOrderId = providerOrderId;
    meta.checkoutIntentId = checkoutIntentIdFromPayload || meta.checkoutIntentId || null;
    meta.lastWebhookAt = now;
    meta.lastWebhookEvent = eventType;
    meta.lastWebhookRawState = rawState;
    meta.lastWebhookStatus = status || meta.lastWebhookStatus || '';
    if (intentId) meta.lastWebhookIntentId = intentId;
    if (statusFromApi) {
      meta.lastStatusSource = 'api';
      meta.lastStatusFromApi = statusFromApi;
      meta.lastStatusCheckedAt = now;
    } else {
      meta.lastStatusSource = meta.lastStatusSource || 'webhook';
    }

    const paymentData = (data?.payment && typeof data.payment === 'object') ? data.payment : {};
    const paymentSnapshot = {
      at: now,
      status,
      rawState,
      source: statusFromApi ? 'api+webhook' : 'webhook',
      intentId: intentId || null,
      paymentId: String(paymentData?.id || paymentData?.paymentId || data?.id || '') || null,
      eventId: String(payload?.id || payload?.eventId || '') || null,
      installmentNumber: Number(paymentData?.installmentNumber ?? paymentData?.rank ?? payload?.metadata?.installmentNumber ?? NaN),
      totalInstallments: Number(paymentData?.installmentCount ?? paymentData?.termsCount ?? order.paymentSplit ?? order.installments ?? NaN),
      amountCents: Number(paymentData?.amount ?? paymentData?.amountCents ?? paymentData?.amountWithoutFees ?? data?.amount ?? NaN),
    };
    if (Number.isNaN(paymentSnapshot.installmentNumber)) delete paymentSnapshot.installmentNumber;
    if (Number.isNaN(paymentSnapshot.totalInstallments)) delete paymentSnapshot.totalInstallments;
    if (Number.isNaN(paymentSnapshot.amountCents)) delete paymentSnapshot.amountCents;
    if (!paymentSnapshot.paymentId) delete paymentSnapshot.paymentId;
    if (!paymentSnapshot.eventId) delete paymentSnapshot.eventId;

    meta.lastPaymentSnapshot = paymentSnapshot;
    const history = Array.isArray(meta.paymentHistory) ? meta.paymentHistory.slice(-9) : [];
    history.push(paymentSnapshot);
    meta.paymentHistory = history;

    const installmentNumber = Object.prototype.hasOwnProperty.call(paymentSnapshot, 'installmentNumber')
      ? Number(paymentSnapshot.installmentNumber)
      : null;
    const totalInstallmentsReported = Object.prototype.hasOwnProperty.call(paymentSnapshot, 'totalInstallments')
      ? Number(paymentSnapshot.totalInstallments)
      : null;
    const hasInstallmentSignals =
      (Number.isFinite(totalInstallmentsReported) && totalInstallmentsReported > 0) ||
      (Number.isFinite(installmentNumber) && installmentNumber >= 0) ||
      (meta.installments && typeof meta.installments === 'object');
    if (hasInstallmentSignals) {
      const installmentsMeta = { ...(meta.installments || {}) };
      const expectedFromSnapshot = Number.isFinite(totalInstallmentsReported) && totalInstallmentsReported > 0
        ? totalInstallmentsReported
        : null;
      const expectedFromOrder = Number.isFinite(Number(order.paymentSplit))
        ? Number(order.paymentSplit)
        : Number.isFinite(Number(order.installments))
          ? Number(order.installments)
          : null;
      if (expectedFromSnapshot) {
        installmentsMeta.expected = expectedFromSnapshot;
      } else if (!installmentsMeta.expected && expectedFromOrder) {
        installmentsMeta.expected = expectedFromOrder;
      }
      if (Number.isFinite(installmentNumber)) {
        installmentsMeta.lastNumber = installmentNumber;
      }
      if (typeof paymentSnapshot.amountCents === 'number' && !Number.isNaN(paymentSnapshot.amountCents)) {
        installmentsMeta.lastAmountCents = paymentSnapshot.amountCents;
      }
      installmentsMeta.lastStatus = status || rawState || '';
      installmentsMeta.updatedAt = now;

      const paidNumbers = Array.isArray(installmentsMeta.paidNumbers) ? installmentsMeta.paidNumbers.slice() : [];
      if (isPaidLike(status) && Number.isFinite(installmentNumber)) {
        if (!paidNumbers.includes(installmentNumber)) {
          paidNumbers.push(installmentNumber);
        }
      }
      paidNumbers.sort((a, b) => a - b);
      if (paidNumbers.length) {
        installmentsMeta.paidNumbers = paidNumbers;
      }

      const amountMap = installmentsMeta.paidAmountsByNumber && typeof installmentsMeta.paidAmountsByNumber === 'object'
        ? { ...installmentsMeta.paidAmountsByNumber }
        : {};
      if (isPaidLike(status) && Number.isFinite(installmentNumber) &&
          typeof paymentSnapshot.amountCents === 'number' && !Number.isNaN(paymentSnapshot.amountCents)) {
        amountMap[installmentNumber] = paymentSnapshot.amountCents;
      }
      if (Object.keys(amountMap).length) {
        installmentsMeta.paidAmountsByNumber = amountMap;
        installmentsMeta.paidAmountCents = Object.values(amountMap).reduce((sum, val) => sum + Number(val || 0), 0);
        installmentsMeta.paidCount = Object.keys(amountMap).length;
      }

      meta.installments = installmentsMeta;
    }

    const isRefundEvent = isRefundedLike(status) || isRefundedLike(rawState);
    if (isRefundEvent) {
      const refundHistory = Array.isArray(meta.refunds) ? meta.refunds.slice(-9) : [];
      refundHistory.push({
        at: now,
        status: status || rawState || 'refunded',
        amountCents: paymentSnapshot.amountCents ?? null,
        paymentId: paymentSnapshot.paymentId || null,
        installmentNumber: Number.isFinite(installmentNumber) ? installmentNumber : null
      });
      meta.refunds = refundHistory;
      meta.lastRefundAt = now;
      meta.lastRefundStatus = status || rawState || 'refunded';
      if (order.status !== 'refunded') {
        order.status = 'refunded';
      }
    }

    order.paymentProviderMeta = meta;
    order.markModified('paymentProviderMeta');
    order.markModified('paymentProviderMeta.paymentHistory');
    await order.save();
    
    if (isRefundEvent) {
      return res.status(200).send('refunded');
    }

    if (isPaidLike(status)) {
      const fin = await finalizePaidIfNoConflict(order);
      if (fin.ok) {
        if (!fin.alreadyFinalized) {
          await sendOrderAttestationIfNeeded(order, { source: 'webhook' });
        }
        return res.status(200).send(fin.alreadyFinalized ? 'ok-already-finalized' : 'ok');
      } else {
        await sendConflictEmail(order);
        // on renvoie 200: le webhook a été traité (même s’il mène à failed)
        return res.status(200).send('conflict');
      }
    } else {
      if (order.status !== 'paid' && order.status !== 'refunded') {
        order.status = 'pending';
        await order.save();
      }
      return res.status(200).send('pending');
    }
  } catch (e) {
    console.error('[pay/webhook] error:', e);
    return res.status(500).send('error');
  }
});


export default router;
