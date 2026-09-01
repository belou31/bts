// stub_sumup/server.js
// Standalone SumUp checkout stub for local development.


import express from 'express';
import crypto from 'node:crypto';

const app = express();
const HOST = process.env.SUMUP_STUB_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.SUMUP_STUB_PORT || 3015);
const BASE_URL = `http://${HOST}:${PORT}`;
const WEBHOOK_TARGET = process.env.SUMUP_WEBHOOK_URL || process.env.SUMUP_CALLBACK_URL || 'http://localhost:8080/pay/webhook';
const WEBHOOK_DELAY_MS = Number.isFinite(Number(process.env.SUMUP_STUB_WEBHOOK_DELAY_MS))
  ? Number(process.env.SUMUP_STUB_WEBHOOK_DELAY_MS)
  : 400;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const checkouts = new Map();         // checkout_reference -> checkout
const checkoutsById = new Map();     // id -> checkout (real SumUp's GET /v0.1/checkouts/{id} looks up by id, not by the merchant reference)
const webhookTimers = new Map();
let defaultScenario = 'manual'; // manual | success | failure

function uuid(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatAmount(value, currency) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const ccy = escapeHtml(String(currency || 'EUR').toUpperCase());
  return `${num.toFixed(2)} ${ccy}`;
}

function computeInstallmentPlan(checkout, source = {}) {
  const totalRaw = Number(source.installments || source.installmentCount || source.installmentsCount || source.terms?.length || checkout.installments?.total || 1);
  const total = Math.max(1, totalRaw);
  const amount = Number(checkout.amount || 0);
  const amounts = [];
  if (total <= 1) {
    amounts.push(amount);
  } else {
    const base = Math.floor((amount * 100) / total) / 100;
    const remainder = amount - base * total;
    amounts.push(base + remainder);
    for (let i = 1; i < total; i++) {
      amounts.push(base);
    }
  }
  const existing = checkout.installments || {};
  const paidNumbers = Array.isArray(existing.paidNumbers) ? existing.paidNumbers.slice() : [];
  if (total >= 1 && !paidNumbers.includes(1)) {
    paidNumbers.push(1);
  }
  paidNumbers.sort((a, b) => a - b);
  let statuses = Array.isArray(existing.statuses) && existing.statuses.length === total
    ? existing.statuses.slice()
    : Array(total).fill('pending');
  if (statuses.length !== total) {
    statuses = Array(total).fill('pending');
  }
  if (total >= 1) {
    statuses[0] = 'paid';
  }
  for (const paid of paidNumbers) {
    if (paid >= 1 && paid <= total) statuses[paid - 1] = 'paid';
  }
  const lastSentNumber = existing.lastSentNumber || (paidNumbers.length ? Math.max(...paidNumbers) : (total >= 1 ? 1 : 0));
  return {
    total,
    amounts,
    paidNumbers,
    lastSentNumber,
    statuses
  };
}

function nextInstallmentNumber(checkout) {
  const inst = checkout.installments;
  if (!inst || !inst.total) return null;
  const paid = Array.isArray(inst.paidNumbers) ? inst.paidNumbers : [];
  const maxPaid = paid.length ? Math.max(...paid) : 0;
  const baseline = inst.lastSentNumber || maxPaid;
  const next = baseline + 1;
  return next > inst.total ? null : next;
}

function formatInstallmentProgress(checkout) {
  const inst = checkout.installments;
  if (!inst || !inst.total || inst.total <= 1) return '—';
  const statuses = Array.isArray(inst.statuses) && inst.statuses.length === inst.total
    ? inst.statuses
    : Array(inst.total).fill('pending');
  return statuses.map(s => escapeHtml(String(s))).join(' ');
}

async function postWebhookForCheckout(checkout, payload, trigger = 'manual') {
  if (!WEBHOOK_TARGET) return;
  const record = {
    trigger,
    status: checkout.status,
    at: nowIso()
  };
  try {
    const res = await fetch(WEBHOOK_TARGET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    record.httpStatus = res.status;
    record.ok = res.ok;
  } catch (err) {
    record.ok = false;
    record.error = err?.message || String(err);
    console.warn('[stub_sumup] webhook failed:', record.error);
  } finally {
    checkout.webhookHistory.push(record);
    checkout.webhookHistory = checkout.webhookHistory.slice(-10);
    checkout.webhookLastSentAt = record.at;
  }
}

function scheduleWebhook(checkout, trigger = 'manual') {
  if (!WEBHOOK_TARGET) return;
  if (!checkout || checkout.status === 'PENDING') return;
  const delay = WEBHOOK_DELAY_MS >= 0 ? WEBHOOK_DELAY_MS : 400;
  if (webhookTimers.has(checkout.id)) {
    clearTimeout(webhookTimers.get(checkout.id));
  }
  if (!checkout.transaction_code) {
    checkout.transaction_code = uuid('tr');
  }
  const timer = setTimeout(async () => {
    webhookTimers.delete(checkout.id);
    const txCode = checkout.transaction_code || uuid('tr');
    checkout.transaction_code = txCode;
    const at = nowIso();
    const payload = {
      id: uuid('evt'),
      event_type: 'checkout.status',
      created_at: at,
      data: {
        id: checkout.id,
        checkout_reference: checkout.checkout_reference,
        amount: checkout.amount,
        currency: checkout.currency,
        status: checkout.status,
        custom_id: checkout.custom_id,
        transaction_code: txCode,
        timestamp: at
      }
    };
    await postWebhookForCheckout(checkout, payload, trigger);
  }, delay);
  webhookTimers.set(checkout.id, timer);
}

function renderLayout(title, body) {
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 32px; }
      h1, h2 { margin-bottom: 12px; }
      table { width: 100%; border-collapse: collapse; margin-top: 16px; }
      th, td { border: 1px solid #d0d7de33; padding: 8px 12px; text-align: left; }
      th { background: #f6f8fa22; }
      code { background: #d0d7de33; padding: 2px 4px; border-radius: 4px; }
      form { display: inline; margin-right: 8px; }
      .badge { display:inline-block; padding:3px 8px; border-radius:999px; font-size:0.75rem; margin-left:6px; }
      .badge.PENDING { background:#facc1533; color:#92400E; }
      .badge.PAID { background:#22c55e33; color:#14532D; }
      .badge.FAILED { background:#f9731633; color:#7C2D12; }
      .badge.REFUNDED { background:#38bdf833; color:#0f172a; }
      .muted { color:#666; font-size:0.85rem; }
      .toolbar { display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-bottom:16px; }
      .pill { border:1px solid #d0d7de66; padding:6px 10px; border-radius:12px; }
      .actions a, .actions button { margin-right: 6px; }
      table.dashboard col.col-ref { width: 11%; }
      table.dashboard col.col-status { width: 9%; }
      table.dashboard col.col-actions { width: 22%; }
      table.dashboard col.col-history { width: 22%; }
      table.dashboard col.col-amount { width: 9%; }
      table.dashboard col.col-article { width: auto; }
      .history { font-size:0.85rem; color:#555; line-height:1.4; }
      .history strong { font-weight:600; }
      .installments { font-size:0.85rem; margin-top:4px; color:#111827; text-transform: lowercase; letter-spacing:0.02em; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

app.post('/token', (_req, res) => {
  res.json({
    access_token: 'sumup-stub-token',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'payments'
  });
});

app.post('/v0.1/checkouts', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = uuid('chk');
  const reference = body.checkout_reference || uuid('ref');
  const transactionCode = body.transaction_code || uuid('tr');
  const checkout = {
    id,
    checkout_reference: reference,
    custom_id: body.custom_id || '',
    amount: Number(body.amount || 0),
    currency: String(body.currency || 'EUR').toUpperCase(),
    status: 'PENDING',
    created_at: nowIso(),
    updated_at: nowIso(),
    return_url: body.return_url || '',
    cancel_url: body.cancel_url || '',
    failure_url: body.failure_url || '',
    callback_url: body.callback_url || '',
    merchant_code: body.merchant_code || '',
    pay_to_email: body.pay_to_email || '',
    description: body.description || body.title || '',
    transaction_code: transactionCode,
    webhookHistory: [],
    webhookLastSentAt: null,
    resolved_at: null,
    scenario: defaultScenario
  };
  checkout.installments = computeInstallmentPlan(checkout, body);
  checkouts.set(reference, checkout);
  checkoutsById.set(id, checkout);
  res.json({
    id,
    checkout_reference: reference,
    amount: checkout.amount,
    currency: checkout.currency,
    status: checkout.status,
    checkout_url: `${BASE_URL}/simulate/${encodeURIComponent(reference)}`,
    custom_id: checkout.custom_id,
    transaction_code: transactionCode,
    links: [{ rel: 'checkout', href: `${BASE_URL}/simulate/${encodeURIComponent(reference)}` }]
  });
});

function loadCheckout(ref, res) {
  const checkout = checkouts.get(ref) || checkoutsById.get(ref);
  if (!checkout) {
    res.status(404).json({ error: 'checkout_not_found' });
    return null;
  }
  return checkout;
}

app.get('/v0.1/checkouts/:ref', (req, res) => {
  const ref = req.params.ref;
  const checkout = loadCheckout(ref, res);
  if (!checkout) return;
  res.json({
    id: checkout.id,
    checkout_reference: checkout.checkout_reference,
    amount: checkout.amount,
    currency: checkout.currency,
    status: checkout.status,
    custom_id: checkout.custom_id,
    transaction_code: checkout.transaction_code || null,
    transaction_id: checkout.transaction_code || null,
    updated_at: checkout.updated_at,
    created_at: checkout.created_at,
    checkout_url: `${BASE_URL}/simulate/${encodeURIComponent(checkout.checkout_reference)}`,
    installments: checkout.installments || null
  });
});

app.get('/', (_req, res) => {
  const rows = Array.from(checkouts.values())
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(chk => {
      const status = escapeHtml(chk.status);
      const intentHref = `/simulate/${encodeURIComponent(chk.checkout_reference)}`;
      const intentId = `<a href="${intentHref}"><code>${escapeHtml(chk.checkout_reference)}</code></a>`;
      const providerOrderId = chk.id ? `<code>${escapeHtml(chk.id)}</code>` : '<span class="muted">—</span>';
      const paymentId = chk.transaction_code ? `<code>${escapeHtml(chk.transaction_code)}</code>` : '<span class="muted">—</span>';
      const article = escapeHtml(chk.description || chk.custom_id || '—');
      const amount = formatAmount(chk.amount, chk.currency);
      const webhookInfo = WEBHOOK_TARGET ? (chk.webhookLastSentAt || '—') : 'désactivé';
      chk.installments = computeInstallmentPlan(chk);
      const planInfo = formatInstallmentProgress(chk);
      const totalInst = Number(chk.installments?.total || 1);
      const paidCount = Array.isArray(chk.installments?.paidNumbers) ? chk.installments.paidNumbers.length : 0;
      const remainingInstallments = totalInst > 1 ? Math.max(0, totalInst - paidCount) : 0;
      const canTriggerInstallment = remainingInstallments > 0 && !['FAILED', 'CANCELED', 'REFUNDED'].includes(chk.status);
      return `
        <tr>
          <td>${intentId}</td>
          <td>${providerOrderId}</td>
          <td>${paymentId}</td>
          <td><span class="badge ${status}">${status}</span>${planInfo !== '—' ? `<div class="installments">${planInfo}</div>` : ''}</td>
          <td>
            <div class="actions">
              <form method="post" action="/checkouts/${encodeURIComponent(chk.checkout_reference)}/status">
                <input type="hidden" name="status" value="PAID">
                <button type="submit">Marquer payé</button>
              </form>
              <form method="post" action="/checkouts/${encodeURIComponent(chk.checkout_reference)}/status">
                <input type="hidden" name="status" value="FAILED">
                <button type="submit">Marquer échoué</button>
              </form>
              <form method="post" action="/checkouts/${encodeURIComponent(chk.checkout_reference)}/status">
                <input type="hidden" name="status" value="PENDING">
                <button type="submit">Revenir en attente</button>
              </form>
              <form method="post" action="/checkouts/${encodeURIComponent(chk.checkout_reference)}/refund">
                <button type="submit">Rembourser</button>
              </form>
              ${canTriggerInstallment ? `
                <form method="post" action="/checkouts/${encodeURIComponent(chk.checkout_reference)}/installment">
                  <button type="submit">Payer échéance</button>
                </form>
              ` : ''}
            </div>
          </td>
          <td class="history">
            <div><strong>Créé</strong>&nbsp;: ${escapeHtml(chk.created_at)}</div>
            <div><strong>Webhook</strong>&nbsp;: ${escapeHtml(String(webhookInfo))}</div>
          </td>
          <td>${amount}</td>
          <td>${article}</td>
        </tr>
      `;
    }).join('');

  const table = rows
    ? `<table class="dashboard">
        <colgroup>
          <col class="col-ref">
          <col class="col-ref">
          <col class="col-ref">
          <col class="col-status">
          <col class="col-actions">
          <col class="col-history">
          <col class="col-amount">
          <col class="col-article">
        </colgroup>
        <thead>
          <tr>
            <th>Demande</th>
            <th>Commande</th>
            <th>Paiement</th>
            <th>Statut</th>
            <th>Actions</th>
            <th>Historique</th>
            <th>Montant</th>
            <th>Article</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    : '<p>Aucun checkout pour le moment.</p>';

  const body = `
    <h1>SumUp Stub</h1>
    <p class="muted">API disponible sur <code>${escapeHtml(BASE_URL)}</code></p>
    <form method="post" action="/default-scenario" id="scenario-form">
      <div class="pill">
        <label><input type="radio" name="scenario" value="manual"${defaultScenario === 'manual' ? ' checked' : ''}> Manuel</label>
        <label><input type="radio" name="scenario" value="success"${defaultScenario === 'success' ? ' checked' : ''}> Succès auto</label>
        <label><input type="radio" name="scenario" value="failure"${defaultScenario === 'failure' ? ' checked' : ''}> Échec auto</label>
      </div>
    </form>
    <p class="muted">Actuel : <strong>${escapeHtml(defaultScenario)}</strong> — changement appliqué immédiatement.</p>
    ${WEBHOOK_TARGET ? `<div class="pill">Webhook → <code>${escapeHtml(WEBHOOK_TARGET)}</code></div>` : '<p class="muted">Webhook désactivé (définir SUMUP_WEBHOOK_URL).</p>'}
    ${table}
    <script>
      (function(){
        const scenarioForm = document.getElementById('scenario-form');
        if (!scenarioForm) return;
        scenarioForm.querySelectorAll('input[name="scenario"]').forEach(radio => {
          radio.addEventListener('change', () => scenarioForm.submit());
        });
      })();
    </script>
  `;
  res.send(renderLayout('SumUp Stub', body));
});

function redirectBack(req, res, fallback = '/') {
  const ref = req.get('Referer') || req.get('Referrer');
  if (!ref) return res.redirect(fallback);
  try {
    const url = new URL(ref);
    if (url.host === req.get('host')) {
      res.redirect(url.pathname + url.search + url.hash);
      return;
    }
  } catch {}
  res.redirect(fallback);
}

app.post('/checkouts/:ref/status', (req, res) => {
  const ref = req.params.ref;
  const checkout = loadCheckout(ref, res);
  if (!checkout) return;
  const status = String(req.body?.status || '').toUpperCase();
  if (!['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'CANCELED'].includes(status)) {
    return redirectBack(req, res);
  }
  checkout.status = status === 'CANCELLED' ? 'FAILED' : status;
  checkout.updated_at = nowIso();
  checkout.installments = computeInstallmentPlan(checkout);
  if (checkout.installments && checkout.installments.total > 1) {
    const plan = checkout.installments;
    if (!Array.isArray(plan.statuses) || plan.statuses.length !== plan.total) {
      plan.statuses = Array(plan.total).fill('pending');
    }
    if (checkout.status === 'PAID') {
      plan.statuses = plan.statuses.map(() => 'paid');
      plan.paidNumbers = Array.from({ length: plan.total }, (_, i) => i + 1);
      plan.lastSentNumber = plan.total;
    }
  }
  scheduleWebhook(checkout, 'manual-status');
  redirectBack(req, res);
});

app.post('/default-scenario', (req, res) => {
  const scenario = String(req.body?.scenario || '').toLowerCase();
  if (['manual', 'success', 'failure'].includes(scenario)) {
    defaultScenario = scenario;
  }
  redirectBack(req, res);
});

app.post('/checkouts/:ref/defer', (req, res) => {
  const ref = req.params.ref;
  const checkout = loadCheckout(ref, res);
  if (!checkout) return;
  if (webhookTimers.has(checkout.id)) {
    clearTimeout(webhookTimers.get(checkout.id));
    webhookTimers.delete(checkout.id);
  }
  checkout.status = 'PENDING';
  checkout.updated_at = nowIso();
  let delaySeconds = Number(req.body?.delaySeconds);
  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) delaySeconds = 30;
  const timer = setTimeout(() => {
    checkout.status = 'PAID';
    checkout.updated_at = nowIso();
    checkout.resolved_at = checkout.updated_at;
    scheduleWebhook(checkout, 'deferred-auto');
  }, Math.round(delaySeconds) * 1000);
  webhookTimers.set(checkout.id, timer);
  redirectBack(req, res);
});

app.post('/checkouts/:ref/confirm-no-webhook', (req, res) => {
  const ref = req.params.ref;
  const checkout = loadCheckout(ref, res);
  if (!checkout) return;
  if (webhookTimers.has(checkout.id)) {
    clearTimeout(webhookTimers.get(checkout.id));
    webhookTimers.delete(checkout.id);
  }
  checkout.status = 'PAID';
  checkout.updated_at = nowIso();
  checkout.resolved_at = checkout.updated_at;
  redirectBack(req, res);
});

app.post('/checkouts/:ref/installment', async (req, res) => {
  const ref = req.params.ref;
  const checkout = loadCheckout(ref, res);
  if (!checkout) return;
  if (webhookTimers.has(checkout.id)) {
    clearTimeout(webhookTimers.get(checkout.id));
    webhookTimers.delete(checkout.id);
  }
  checkout.installments = computeInstallmentPlan(checkout);
  const plan = checkout.installments;
  if (!plan || plan.total <= 1) {
    return redirectBack(req, res);
  }
  if (!Array.isArray(plan.paidNumbers)) plan.paidNumbers = [];
  if (!Array.isArray(plan.statuses) || plan.statuses.length !== plan.total) {
    plan.statuses = Array(plan.total).fill('pending');
  }
  const next = nextInstallmentNumber(checkout) || (plan.paidNumbers.length + 1);
  if (next > plan.total) {
    return redirectBack(req, res);
  }
  if (!plan.paidNumbers.includes(next)) plan.paidNumbers.push(next);
  plan.paidNumbers.sort((a, b) => a - b);
  plan.statuses[next - 1] = 'paid';

  const amount = Number(plan.amounts && Number.isFinite(Number(plan.amounts[next - 1]))
    ? Number(plan.amounts[next - 1])
    : Number(checkout.amount || 0) / plan.total);

  const at = nowIso();
  plan.lastSentNumber = next;
  plan.lastSentAt = at;

  const isFinal = plan.paidNumbers.length >= plan.total;
  checkout.updated_at = at;
  if (isFinal) {
    checkout.status = 'PAID';
    checkout.resolved_at = at;
    plan.statuses = plan.statuses.map(() => 'paid');
  } else {
    checkout.status = 'PENDING';
    checkout.resolved_at = null;
  }

  const txCode = uuid('tr');
  checkout.transaction_code = txCode;

  const payload = {
    id: uuid('evt'),
    event_type: 'checkout.status',
    created_at: at,
    data: {
      id: checkout.id,
      checkout_reference: checkout.checkout_reference,
      amount,
      currency: checkout.currency,
      status: checkout.status,
      custom_id: checkout.custom_id,
      transaction_code: txCode,
      timestamp: at,
      installment_number: next,
      installment_count: plan.total
    }
  };

  await postWebhookForCheckout(checkout, payload, isFinal ? 'installment-final' : 'installment');
  redirectBack(req, res);
});

app.post('/checkouts/:ref/refund', (req, res) => {
  const ref = req.params.ref;
  const checkout = loadCheckout(ref, res);
  if (!checkout) return;
  if (webhookTimers.has(checkout.id)) {
    clearTimeout(webhookTimers.get(checkout.id));
    webhookTimers.delete(checkout.id);
  }
  checkout.status = 'REFUNDED';
  checkout.updated_at = nowIso();
  checkout.resolved_at = checkout.updated_at;
  scheduleWebhook(checkout, 'manual-refund');
  redirectBack(req, res);
});

function loadCheckoutById(id) {
  return Array.from(checkouts.values()).find(chk => chk.checkout_reference === id || chk.id === id) || null;
}

function applyOutcome(checkout, outcome) {
  if (!checkout) return 'noop';
  checkout.updated_at = nowIso();
  checkout.scenario = outcome;

  if (outcome === 'success') {
    if (defaultScenario === 'success') {
      checkout.status = 'PAID';
      checkout.resolved_at = checkout.updated_at;
      return 'auto-success';
    }
    if (defaultScenario === 'failure') {
      checkout.status = 'FAILED';
      checkout.resolved_at = checkout.updated_at;
      return 'auto-failure';
    }
    checkout.status = 'PENDING';
    checkout.resolved_at = null;
    return 'manual';
  }
  if (outcome === 'failure') {
    checkout.status = 'FAILED';
    checkout.resolved_at = checkout.updated_at;
    return 'failure';
  }
  if (outcome === 'error') {
    checkout.status = 'FAILED';
    checkout.resolved_at = checkout.updated_at;
    return 'error';
  }
  if (outcome === 'back' || outcome === 'pending') {
    checkout.status = 'PENDING';
    checkout.resolved_at = null;
    return 'back';
  }
  return 'noop';
}

app.get('/simulate/:ref', (req, res) => {
  const checkout = loadCheckoutById(req.params.ref);
  if (!checkout) {
    res.status(404).send(renderLayout('Inconnu', '<p>Checkout introuvable.</p>'));
    return;
  }
  const body = `
    <h1>Simuler le paiement</h1>
    <p>Checkout: <code>${escapeHtml(checkout.checkout_reference)}</code> (<span class="badge ${escapeHtml(checkout.status)}">${escapeHtml(checkout.status)}</span>)</p>
    <p>Montant: <strong>${escapeHtml(checkout.amount)} ${escapeHtml(checkout.currency)}</strong></p>
    <p class="muted">Scénario par défaut : <strong>${escapeHtml(defaultScenario)}</strong></p>
    <section>
      <h2>Valider &amp; retour vers BTS</h2>
      <form method="get" action="/simulate/${encodeURIComponent(checkout.checkout_reference)}/redirect" data-confirm-form>
        <input type="hidden" name="result" value="success">
        <fieldset class="confirm-options">
          <legend>Marquer comme payé :</legend>
          <label><input type="radio" name="paymentMode" value="default" checked> Scénario par défaut (<strong>${escapeHtml(defaultScenario)}</strong>)</label>
          <label><input type="radio" name="paymentMode" value="yes"> Oui, confirmation immédiate</label>
          <label><input type="radio" name="paymentMode" value="delay"> Oui, après <input type="number" name="delay" value="30" min="1" style="width:4rem"> s</label>
          <label><input type="radio" name="paymentMode" value="no"> Non, rester en attente</label>
        </fieldset>
        <fieldset class="confirm-options">
          <legend>Webhook après confirmation :</legend>
          <label><input type="radio" name="webhookMode" value="yes" checked> Oui</label>
          <label><input type="radio" name="webhookMode" value="no"> Non</label>
        </fieldset>
        <button type="submit">Simuler CONFIRMATION</button>
      </form>
    </section>
    <section>
      <h2>Redirections sans confirmation</h2>
      <p>
        <a href="/simulate/${encodeURIComponent(checkout.checkout_reference)}/redirect?result=back">↩️ Abandon (cancel_url)</a><br>
        <a href="/simulate/${encodeURIComponent(checkout.checkout_reference)}/redirect?result=failure">❌ Échec (failure_url)</a><br>
        <a href="/simulate/${encodeURIComponent(checkout.checkout_reference)}/redirect?result=error">⚠️ Erreur (failure_url)</a>
      </p>
    </section>
    <p class="muted">Retour prévu: ${escapeHtml(checkout.return_url || '(non défini)')}</p>
    <p><a href="/">← Revenir au tableau des checkouts</a></p>
    <script>
      (function(){
        const scenarioForm = document.getElementById('scenario-form');
        if (scenarioForm) {
          scenarioForm.querySelectorAll('input[name="scenario"]').forEach(r => r.addEventListener('change', () => scenarioForm.submit()));
        }

        const form = document.querySelector('[data-confirm-form]');
        if (!form) return;
        const delayInput = form.querySelector('input[name="delay"]');
        const paymentRadios = form.querySelectorAll('input[name="paymentMode"]');

        function toggleDelay(){
          if (!delayInput) return;
          const current = form.querySelector('input[name="paymentMode"]:checked');
          const value = current ? current.value : '';
          delayInput.disabled = !(value === 'delay' || value === 'confirm-later');
        }

        paymentRadios.forEach(r => r.addEventListener('change', toggleDelay));
        toggleDelay();
      })();
    </script>
  `;
  res.send(renderLayout('Simulation SumUp', body));
});

app.get('/simulate/:ref/redirect', (req, res) => {
  const checkout = loadCheckoutById(req.params.ref);
  if (!checkout) {
    res.status(404).send(renderLayout('Inconnu', '<p>Checkout introuvable.</p>'));
    return;
  }
  const outcome = String(req.query?.result || '').toLowerCase();
  if (!['success', 'failure', 'pending', 'back', 'error'].includes(outcome)) {
    return res.redirect(`/simulate/${encodeURIComponent(checkout.checkout_reference)}`);
  }
  let paymentMode = String(req.query?.paymentMode || 'default').toLowerCase();
  if (paymentMode === 'confirm-now') paymentMode = 'yes';
  if (paymentMode === 'confirm-later') paymentMode = 'delay';
  if (paymentMode === 'keep-pending') paymentMode = 'no';
  let webhookMode = String(req.query?.webhookMode || 'yes').toLowerCase();
  if (webhookMode === 'default' || webhookMode === 'send') webhookMode = 'yes';
  if (webhookMode === 'skip') webhookMode = 'no';
  const shouldSendWebhook = webhookMode === 'yes';
  const delayParam = Number(req.query?.delay || req.query?.delaySeconds);
  let trigger = 'manual';

  if (webhookTimers.has(checkout.id)) {
    clearTimeout(webhookTimers.get(checkout.id));
    webhookTimers.delete(checkout.id);
  }

  if (paymentMode === 'default') {
    trigger = applyOutcome(checkout, outcome);
  } else if (paymentMode === 'yes') {
    checkout.status = 'PAID';
    checkout.updated_at = nowIso();
    checkout.resolved_at = checkout.updated_at;
    trigger = 'manual-confirm-now';
  } else if (paymentMode === 'delay') {
    checkout.status = 'PENDING';
    checkout.updated_at = nowIso();
    checkout.resolved_at = null;
    const seconds = Number.isFinite(delayParam) && delayParam > 0 ? Math.round(delayParam) : 30;
    const timer = setTimeout(() => {
      checkout.status = 'PAID';
      checkout.updated_at = nowIso();
      checkout.resolved_at = checkout.updated_at;
      if (shouldSendWebhook) {
        scheduleWebhook(checkout, 'manual-confirm-delay');
      }
    }, seconds * 1000);
    webhookTimers.set(checkout.id, timer);
    trigger = 'manual-confirm-delay';
  } else if (paymentMode === 'no') {
    checkout.status = 'PENDING';
    checkout.updated_at = nowIso();
    checkout.resolved_at = null;
    trigger = 'manual-keep-pending';
  }

  if (paymentMode !== 'delay') {
    if (shouldSendWebhook && checkout.status !== 'PENDING') {
      const skip = new Set(['back', 'manual', 'noop', 'manual-keep-pending']);
      const label = trigger && !skip.has(trigger) ? `simulate-${trigger}` : 'simulate-manual';
      scheduleWebhook(checkout, label);
    }
  }

  let target = checkout.return_url || '';
  if (trigger === 'back' || checkout.status === 'CANCELED') {
    target = checkout.cancel_url || checkout.return_url;
  } else if (checkout.status === 'FAILED' || trigger === 'error') {
    target = checkout.failure_url || checkout.return_url;
  }

  if (!target) {
    res.send(renderLayout('Pas d’URL de retour', '<p>Aucune URL configurée pour ce checkout.</p>'));
    return;
  }
  const params = new URLSearchParams();
  params.set('checkout_reference', checkout.checkout_reference);
  params.set('ci', checkout.checkout_reference);
  params.set('status', checkout.status);
  params.set('orderId', checkout.id || checkout.checkout_reference);
  if (checkout.transaction_code) params.set('paymentId', checkout.transaction_code);
  if (checkout.custom_id) params.set('custom_id', checkout.custom_id);
  const sep = target.includes('?') ? '&' : '?';
  res.redirect(`${target}${sep}${params.toString()}`);
});

app.get('/checkouts.json', (_req, res) => {
  res.json({
    webhookTarget: WEBHOOK_TARGET || null,
    checkouts: Array.from(checkouts.values())
  });
});

app.listen(PORT, HOST, () => {
  console.log(`[stub_sumup] listening on ${BASE_URL}`);
  console.log('[stub_sumup] OAuth token endpoint: POST /token');
  console.log('[stub_sumup] Checkout endpoint: POST /v0.1/checkouts');
  if (WEBHOOK_TARGET) {
    console.log(`[stub_sumup] Webhook target: ${WEBHOOK_TARGET}`);
  } else {
    console.log('[stub_sumup] Webhook relay disabled (set SUMUP_WEBHOOK_URL).');
  }
});
