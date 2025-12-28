// stub_helloasso/server.js
// Standalone HelloAsso checkout stub for local development.

import express from 'express';
import crypto from 'node:crypto';
import process from 'node:process';
import url from 'node:url';

const app = express();
const HOST = process.env.HELLOASSO_STUB_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.HELLOASSO_STUB_PORT || 3005);
const BASE_URL = `http://${HOST}:${PORT}`;
const WEBHOOK_TARGET = process.env.HELLOASSO_WEBHOOK_URL || process.env.HELLOASSO_WEBHOOK || 'http://localhost:8080/pay/webhook';
const WEBHOOK_DELAY_MS = Number.isFinite(Number(process.env.HELLOASSO_STUB_WEBHOOK_DELAY_MS))
  ? Number(process.env.HELLOASSO_STUB_WEBHOOK_DELAY_MS)
  : 400;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const intents = new Map();
const webhookTimers = new Map();
let defaultScenario = 'manual'; // manual | success | failure

function genId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function summarizeIntent(intent) {
  const { payload } = intent;
  const payer = payload?.payer || {};
  const lines = Array.isArray(payload?.items) ? payload.items.length : 0;
  return `${escapeHtml(payer.firstName || '')} ${escapeHtml(payer.lastName || '')} • ${lines} article(s)`;
}

function formatCents(value) {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents)) return '—';
  return `&euro; ${(cents / 100).toFixed(2)}`;
}

function computeInstallmentPlan(payload) {
  const total = Math.max(1, totalInstallmentsFromPayload(payload));
  const totalAmount = Number(payload?.totalAmount || 0);
  const plan = [];
  const terms = Array.isArray(payload?.terms) ? payload.terms : [];

  if (total <= 1) {
    plan.push(totalAmount);
  } else {
    const initial = Number.isFinite(Number(payload?.initialAmount))
      ? Number(payload.initialAmount)
      : Math.round(totalAmount / total);
    plan.push(initial);
    for (const term of terms) {
      const amt = Number(term?.amount || 0);
      plan.push(amt);
    }
    while (plan.length < total) {
      plan.push(Math.floor(totalAmount / total));
    }
  }

  const statuses = Array(total).fill('pending');
  const paidNumbers = [];
  if (total >= 1) {
    statuses[0] = 'paid';
    paidNumbers.push(1);
  }
  return {
    total,
    amounts: plan,
    paidNumbers,
    lastSentNumber: total > 1 ? 1 : total,
    statuses
  };
}

function nextInstallmentNumber(intent) {
  const inst = intent.installments;
  if (!inst || !inst.total) return null;
  const paid = Array.isArray(inst.paidNumbers) ? inst.paidNumbers : [];
  const maxPaid = paid.length ? Math.max(...paid) : 0;
  const baseline = inst.lastSentNumber || maxPaid;
  const next = baseline + 1;
  return next > inst.total ? null : next;
}

function formatInstallmentProgress(intent) {
  const inst = intent.installments;
  if (!inst || !inst.total || inst.total <= 1) return '—';
  const statuses = Array.isArray(inst.statuses) && inst.statuses.length === inst.total
    ? inst.statuses
    : Array(inst.total).fill('pending');
  return statuses.map(s => escapeHtml(String(s))).join(' ');
}

async function postWebhookForIntent(intent, payload, trigger) {
  if (!WEBHOOK_TARGET) return;
  const entry = {
    trigger,
    status: intent.status,
    at: new Date().toISOString()
  };
  try {
    const res = await fetch(WEBHOOK_TARGET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    entry.httpStatus = res.status;
    entry.ok = res.ok;
  } catch (err) {
    entry.ok = false;
    entry.error = err?.message || String(err);
    console.warn('[stub_helloasso] webhook failed:', entry.error);
  } finally {
    if (!Array.isArray(intent.webhookHistory)) intent.webhookHistory = [];
    intent.webhookHistory.push(entry);
    intent.webhookHistory = intent.webhookHistory.slice(-10);
    intent.webhookLastStatus = intent.status;
    intent.webhookLastSentAt = entry.at;
  }
}

function buildReturnUrl(intent, outcome) {
  const params = new url.URLSearchParams();
  params.set('checkoutIntentId', intent.id);
  params.set('orderId', intent.providerOrderId);
  params.set('ci', intent.id);
  params.set('code', outcome === 'success' ? 'payment_accepted' : outcome === 'failure' ? 'canceled' : outcome);
  params.set('stub', '1');
  params.set('result', outcome);
  if (intent.syntheticPaymentId) params.set('paymentId', intent.syntheticPaymentId);
  if (intent.payload?.metadata?.orderId || intent.payload?.metadata?.orderNo) {
    params.set('oid', intent.payload.metadata.orderId || intent.payload.metadata.orderNo);
  }
  const base = outcome === 'success'
    ? intent.payload.returnUrl
    : outcome === 'failure'
      ? intent.payload.backUrl || intent.payload.returnUrl
      : intent.payload.errorUrl || intent.payload.returnUrl;
  const trimmed = String(base || '').replace(/\s+/g, '');
  if (!trimmed) return null;
  return trimmed.includes('?') ? `${trimmed}&${params.toString()}` : `${trimmed}?${params.toString()}`;
}

function respondWithIntent(res, intent) {
  return res.json({
    checkoutIntentId: intent.id,
    id: intent.id,
    redirectUrl: `${BASE_URL}/simulate/${intent.id}`,
    url: `${BASE_URL}/simulate/${intent.id}`,
    status: intent.status,
    state: intent.status,
    metadata: intent.payload?.metadata || {},
    payer: intent.payload?.payer || {},
    orderId: intent.providerOrderId,
    order: { id: intent.providerOrderId },
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    lines: intent.payload?.items || [],
    amount: intent.payload?.totalAmount || 0,
    installments: intent.installments || null
  });
}

function statusFromScenario(scenario) {
  switch (scenario) {
    case 'success': return 'paid';
    case 'failure': return 'canceled';
    default: return 'pending';
  }
}

function haStateFromStatus(status) {
  switch (status) {
    case 'paid': return 'payment_succeeded';
    case 'canceled': return 'payment_canceled';
    case 'failed': return 'payment_failed';
    case 'refunded': return 'payment_refunded';
    default: return 'waiting_payment';
  }
}

function totalInstallmentsFromPayload(payload) {
  const terms = Array.isArray(payload?.terms) ? payload.terms.length : 0;
  return Math.max(1, terms + 1);
}

function buildWebhookPayload(intent, overrides = {}) {
  const meta = intent.payload?.metadata || {};
  const payer = intent.payload?.payer || {};
  const plan = intent.installments;
  const totalInstallments = Number.isFinite(overrides.totalInstallments)
    ? overrides.totalInstallments
    : plan?.total || totalInstallmentsFromPayload(intent.payload);
  const amount = Number.isFinite(overrides.amountCents)
    ? overrides.amountCents
    : Number(intent.payload?.totalAmount || 0);
  const paymentId = overrides.paymentId || intent.syntheticPaymentId || genId('pay');
  if (!overrides.keepPreviousPaymentId) {
    intent.syntheticPaymentId = paymentId;
  }
  const state = overrides.state || haStateFromStatus(intent.status);
  const installmentNumber = Number.isFinite(overrides.installmentNumber)
    ? overrides.installmentNumber
    : (plan?.lastSentNumber || totalInstallments);
  const paymentStatus = overrides.paymentStatus || state;
  const now = new Date().toISOString();
  const metadataOrderId = meta.orderId || meta.orderNo || '';

  return {
    id: genId('evt'),
    eventType: 'Payment',
    eventDate: now,
    metadata: {
      orderId: metadataOrderId,
      orderNo: meta.orderNo || '',
      checkoutIntentId: intent.id
    },
    data: {
      id: genId('payload'),
      organizationSlug: intent.organization,
      checkoutIntentId: intent.id,
      order: { id: intent.providerOrderId },
      payment: {
        id: paymentId,
        paymentId,
        amount,
        amountWithoutFees: amount,
        state,
        status: paymentStatus,
        rank: totalInstallments,
        installmentNumber,
        installmentCount: totalInstallments
      },
      payer,
      metadata: {
        orderId: metadataOrderId,
        orderNo: meta.orderNo || ''
      }
    }
  };
}

function cancelScheduledWebhook(intentId) {
  const timer = webhookTimers.get(intentId);
  if (timer) {
    clearTimeout(timer);
    webhookTimers.delete(intentId);
  }
}

function scheduleWebhook(intent, trigger = 'manual') {
  if (!WEBHOOK_TARGET) return;
  if (!intent || intent.status === 'pending') return;

  cancelScheduledWebhook(intent.id);
  const delay = WEBHOOK_DELAY_MS >= 0 ? WEBHOOK_DELAY_MS : 400;
  const timer = setTimeout(async () => {
    webhookTimers.delete(intent.id);
    const payload = buildWebhookPayload(intent);
    await postWebhookForIntent(intent, payload, trigger);
  }, delay);
  webhookTimers.set(intent.id, timer);
}

// OAuth token endpoint stub
app.post('/oauth2/token', (_req, res) => {
  res.json({
    access_token: 'helloasso-stub-token',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'checkout.intent'
  });
});

// Checkout intent creation
app.post('/v5/organizations/:orgSlug/checkout-intents', (req, res) => {
  const orgSlug = req.params.orgSlug;
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const id = genId('ci');
  const providerOrderId = genId('order');
  let status = 'pending';
  const now = new Date().toISOString();

  const installments = computeInstallmentPlan(payload);

  const plan = computeInstallmentPlan(payload);

  const intent = {
    id,
    organization: orgSlug,
    providerOrderId,
    createdAt: now,
    updatedAt: now,
    status,
    scenario: defaultScenario,
    resolvedAt: null,
    payload,
    syntheticPaymentId: genId('pay'),
    webhookHistory: [],
    webhookLastStatus: null,
    webhookLastSentAt: null,
    installments: plan
  };
  intents.set(id, intent);
  respondWithIntent(res, intent);
});

function loadIntent(req, res) {
  const intent = intents.get(req.params.intentId);
  if (!intent) {
    res.status(404).json({ error: 'intent_not_found' });
    return null;
  }
  return intent;
}

// Fetch intent without org scope
app.get('/v5/checkout-intents/:intentId', (req, res) => {
  const intent = loadIntent(req, res);
  if (!intent) return;
  respondWithIntent(res, intent);
});

// Fetch intent with org scope
app.get('/v5/organizations/:orgSlug/checkout-intents/:intentId', (req, res) => {
  const intent = loadIntent(req, res);
  if (!intent) return;
  respondWithIntent(res, intent);
});

function htmlLayout(title, body) {
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 32px; }
      h1, h2 { margin: 0 0 16px; }
      table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
      th, td { border: 1px solid #d0d7de33; padding: 8px 12px; text-align: left; vertical-align: top; }
      th { background: #f6f8fa22; }
      code { background: #d0d7de33; padding: 2px 4px; border-radius: 4px; }
      .badge { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 0.75rem; margin-left: 6px; }
      .badge.pending { background: #facc1533; color: #92400e; }
      .badge.paid { background: #22c55e33; color: #14532d; }
      .badge.canceled, .badge.failed { background: #f9731633; color: #7c2d12; }
      form { display: inline; margin-right: 8px; }
      .muted { color: #666; font-size: 0.85rem; }
      .actions a, .actions button { margin-right: 6px; }
      .pill { padding: 6px 10px; border-radius: 12px; border: 1px solid #d0d7de66; display: inline-flex; align-items: center; gap: 6px; }
      .pill input { margin: 0; }
      .toolbar { display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap:wrap; }
      table.dashboard col.col-ref { width: 11%; }
      table.dashboard col.col-status { width: 9%; }
      table.dashboard col.col-actions { width: 22%; }
      table.dashboard col.col-history { width: 22%; }
      table.dashboard col.col-amount { width: 9%; }
      table.dashboard col.col-article { width: auto; }
      .history { font-size: 0.85rem; color: #555; line-height: 1.4; }
      .history strong { font-weight: 600; }
      .installments { font-size: 0.85rem; margin-top: 4px; color: #111827; text-transform: lowercase; letter-spacing: 0.02em; }
    </style>
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

app.get('/', (_req, res) => {
  const rows = Array.from(intents.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(intent => {
      const status = escapeHtml(intent.status);
      const intentHref = `/simulate/${encodeURIComponent(intent.id)}`;
      const intentLink = `<a href="${intentHref}"><code>${escapeHtml(intent.id)}</code></a>`;
      const providerOrderId = intent.providerOrderId
        ? `<code>${escapeHtml(intent.providerOrderId)}</code>`
        : '<span class="muted">—</span>';
      const paymentId = intent.syntheticPaymentId
        ? `<code>${escapeHtml(intent.syntheticPaymentId)}</code>`
        : '<span class="muted">—</span>';
      const article = summarizeIntent(intent);
      const amount = formatCents(intent.payload?.totalAmount);
      const webhookInfo = WEBHOOK_TARGET
        ? (intent.webhookLastSentAt ? escapeHtml(intent.webhookLastSentAt) : '— en attente —')
        : 'désactivé (HELLOASSO_WEBHOOK_URL non défini)';
      const planInfo = formatInstallmentProgress(intent);
      const remainingInstallments = (() => {
        const inst = intent.installments;
        if (!inst || !inst.total) return 0;
        const paid = Array.isArray(inst.paidNumbers) ? inst.paidNumbers.length : 0;
        return Math.max(0, inst.total - paid);
      })();
      const canTriggerInstallment = remainingInstallments > 0 && intent.status !== 'canceled' && intent.status !== 'failed';
      return `
        <tr>
          <td>${intentLink}</td>
          <td>${providerOrderId}</td>
          <td>${paymentId}</td>
          <td><span class="badge ${status}">${status}</span>${planInfo !== '—' ? `<div class="installments">${planInfo}</div>` : ''}</td>
          <td>
            <div class="actions">
              <form method="post" action="/intents/${escapeHtml(intent.id)}/status">
                <input type="hidden" name="status" value="paid">
                <button type="submit">Marquer payé</button>
              </form>
              <form method="post" action="/intents/${escapeHtml(intent.id)}/status">
                <input type="hidden" name="status" value="canceled">
                <button type="submit">Marquer annulé</button>
              </form>
              <form method="post" action="/intents/${escapeHtml(intent.id)}/status">
                <input type="hidden" name="status" value="pending">
                <button type="submit">Revenir en attente</button>
              </form>
              <form method="post" action="/intents/${escapeHtml(intent.id)}/refund">
                <button type="submit">Rembourser</button>
              </form>
              ${canTriggerInstallment ? `
                <form method="post" action="/intents/${escapeHtml(intent.id)}/installment">
                  <button type="submit">Payer échéance</button>
                </form>
              ` : ''}
            </div>
          </td>
          <td class="history">
            <div><strong>Créé</strong>&nbsp;: ${escapeHtml(intent.createdAt)}</div>
            <div><strong>Webhook</strong>&nbsp;: ${webhookInfo}</div>
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
            <th>Articles</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    : '<p>Aucune intention enregistrée pour le moment.</p>';

  const body = `
    <h1>HelloAsso Stub</h1>
    <p class="muted">Point d’entrée API&nbsp;: <code>${escapeHtml(BASE_URL)}</code></p>
    <form method="post" action="/default-scenario" id="scenario-form">
      <div class="pill">
        <strong>Scénario par défaut :</strong>
        <label><input type="radio" name="scenario" value="manual"${defaultScenario === 'manual' ? ' checked' : ''}> Manuel</label>
        <label><input type="radio" name="scenario" value="success"${defaultScenario === 'success' ? ' checked' : ''}> Succès auto</label>
        <label><input type="radio" name="scenario" value="failure"${defaultScenario === 'failure' ? ' checked' : ''}> Échec auto</label>
      </div>
    </form>
    <p class="muted">Actuel : <strong>${escapeHtml(defaultScenario)}</strong> — changement appliqué immédiatement.</p>
    <form method="post" action="/intents/reset">
      <button type="submit">Purger les intentions</button>
    </form>
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
  res.send(htmlLayout('HelloAsso Stub', body));
});

function redirectBack(req, res, fallback = '/') {
  const ref = req.get('Referer') || req.get('Referrer');
  // Trust same-origin URLs; fallback to provided default
  if (!ref) {
    res.redirect(fallback);
    return;
  }
  try {
    const parsed = new URL(ref);
    const host = req.get('host');
    if (parsed.host === host) {
      const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      res.redirect(path || fallback);
      return;
    }
  } catch {
    // ignore parse errors and fallback below
  }
  res.redirect(fallback);
}

app.post('/default-scenario', (req, res) => {
  const scenario = String(req.body?.scenario || '').toLowerCase();
  if (['manual', 'success', 'failure'].includes(scenario)) {
    defaultScenario = scenario;
  }
  redirectBack(req, res);
});

app.post('/intents/reset', (_req, res) => {
  for (const timer of webhookTimers.values()) {
    clearTimeout(timer);
  }
  webhookTimers.clear();
  intents.clear();
  redirectBack(_req, res);
});

app.post('/intents/:intentId/status', (req, res) => {
  const intent = loadIntent(req, res);
  if (!intent) return;
  const status = String(req.body?.status || '').toLowerCase();
  if (['paid', 'canceled', 'pending', 'failed'].includes(status)) {
    cancelScheduledWebhook(intent.id);
    intent.status = status;
    intent.updatedAt = new Date().toISOString();
    intent.resolvedAt = status === 'pending' ? null : intent.updatedAt;
    if (intent.installments && intent.installments.total > 1) {
      const plan = intent.installments;
      if (!Array.isArray(plan.statuses) || plan.statuses.length !== plan.total) {
        plan.statuses = Array(plan.total).fill('pending');
      }
      if (status === 'paid') {
        plan.statuses = plan.statuses.map(() => 'paid');
        plan.paidNumbers = Array.from({ length: plan.total }, (_, i) => i + 1);
        plan.lastSentNumber = plan.total;
      }
    }
    if (intent.status !== 'pending') {
      scheduleWebhook(intent, 'manual-status');
    }
  }
  redirectBack(req, res);
});

app.post('/intents/:intentId/defer', (req, res) => {
  const intent = loadIntent(req, res);
  if (!intent) return;
  cancelScheduledWebhook(intent.id);
  intent.status = 'pending';
  intent.updatedAt = new Date().toISOString();
  intent.resolvedAt = null;
  let delaySeconds = Number(req.body?.delaySeconds);
  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) delaySeconds = 30;
  const timer = setTimeout(() => {
    intent.status = 'paid';
    intent.updatedAt = new Date().toISOString();
    intent.resolvedAt = intent.updatedAt;
    scheduleWebhook(intent, 'deferred-auto');
  }, Math.round(delaySeconds) * 1000);
  webhookTimers.set(intent.id, timer);
  redirectBack(req, res);
});

app.post('/intents/:intentId/confirm-no-webhook', (req, res) => {
  const intent = loadIntent(req, res);
  if (!intent) return;
  cancelScheduledWebhook(intent.id);
  intent.status = 'paid';
  intent.updatedAt = new Date().toISOString();
  intent.resolvedAt = intent.updatedAt;
  redirectBack(req, res);
});

app.post('/intents/:intentId/refund', (req, res) => {
  const intent = loadIntent(req, res);
  if (!intent) return;
  cancelScheduledWebhook(intent.id);
  intent.status = 'refunded';
  intent.updatedAt = new Date().toISOString();
  intent.resolvedAt = intent.updatedAt;
  scheduleWebhook(intent, 'manual-refund');
  redirectBack(req, res);
});

app.post('/intents/:intentId/installment', async (req, res) => {
  const intent = loadIntent(req, res);
  if (!intent) return;
  cancelScheduledWebhook(intent.id);
  const plan = intent.installments || computeInstallmentPlan(intent.payload);
  intent.installments = plan;
  const total = Number(plan?.total || 1);
  if (total <= 1) {
    return redirectBack(req, res);
  }
  if (!Array.isArray(plan.paidNumbers)) plan.paidNumbers = [];
  if (!plan.paidNumbers.includes(1) && total >= 1) {
    plan.paidNumbers.push(1);
    plan.paidNumbers.sort((a, b) => a - b);
  }
  if (!Array.isArray(plan.statuses) || plan.statuses.length !== total) {
    plan.statuses = Array(total).fill('pending');
    for (const paid of plan.paidNumbers) {
      if (paid >= 1 && paid <= total) plan.statuses[paid - 1] = 'paid';
    }
  }
  const next = nextInstallmentNumber(intent) || (plan.paidNumbers.length + 1);
  if (next > total) {
    return redirectBack(req, res);
  }

  const amount = Number(plan.amounts && Number.isFinite(Number(plan.amounts[next - 1]))
    ? Number(plan.amounts[next - 1])
    : Math.round(Number(intent.payload?.totalAmount || 0) / total));

  const paymentId = genId('pay');
  const now = new Date().toISOString();
  if (!plan.paidNumbers.includes(next)) {
    plan.paidNumbers.push(next);
    plan.paidNumbers.sort((a, b) => a - b);
  }
  plan.lastSentNumber = next;
  plan.lastSentAt = now;
  plan.statuses[next - 1] = 'paid';

  const isFinal = plan.paidNumbers.length >= total;
  intent.updatedAt = now;
  if (isFinal) {
    intent.status = 'paid';
    intent.resolvedAt = now;
    plan.statuses = plan.statuses.map(() => 'paid');
  } else {
    intent.status = 'pending';
    intent.resolvedAt = null;
  }

  const payload = buildWebhookPayload(intent, {
    paymentId,
    amountCents: amount,
    installmentNumber: next,
    totalInstallments: total,
    keepPreviousPaymentId: !isFinal
  });

  await postWebhookForIntent(intent, payload, isFinal ? 'installment-final' : 'installment');

  redirectBack(req, res);
});

app.get('/simulate/:intentId', (req, res) => {
  const intent = loadIntent(req, res);
  if (!intent) return;
  const payload = intent.payload || {};
  const lines = Array.isArray(payload.items) ? payload.items : [];
  const rows = lines.map(item => `
    <tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.amount)}</td></tr>
  `).join('');
  const info = `
    <h1>Simuler le paiement</h1>
    <p>Intent: <code>${escapeHtml(intent.id)}</code></p>
    <p>Montant total&nbsp;: <strong>${escapeHtml(payload.totalAmount || 0)}&nbsp;cts</strong></p>
    <p>Porteur&nbsp;: ${escapeHtml(payload?.payer?.firstName || '')} ${escapeHtml(payload?.payer?.lastName || '')} (${escapeHtml(payload?.payer?.email || '')})</p>
    <p class="muted">Scénario par défaut : <strong>${escapeHtml(defaultScenario)}</strong></p>
    ${rows ? `<table><thead><tr><th>Article</th><th>Montant</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    <section>
      <h2>Valider &amp; retour vers BTS</h2>
      <form method="get" action="/simulate/${escapeHtml(intent.id)}/redirect" data-confirm-form>
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
        <a href="/simulate/${escapeHtml(intent.id)}/redirect?result=back">↩️ Abandonner (backUrl)</a><br>
        <a href="/simulate/${escapeHtml(intent.id)}/redirect?result=failure">❌ Échec (provider)</a><br>
        <a href="/simulate/${escapeHtml(intent.id)}/redirect?result=error">⚠️ Erreur (errorUrl)</a>
      </p>
    </section>
    <p class="muted">Retour prévu&nbsp;: ${escapeHtml(payload.returnUrl || 'n/a')}</p>
    <p><a href="/">← Revenir au tableau des intentions</a></p>
    <script>
      (function(){
        const scenarioForm = document.getElementById('scenario-form');
        if (scenarioForm) {
          const radios = scenarioForm.querySelectorAll('input[name="scenario"]');
          radios.forEach(r => r.addEventListener('change', () => scenarioForm.submit()));
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
  res.send(htmlLayout('Simulation paiement', info));
});

function applyOutcome(intent, outcome) {
  cancelScheduledWebhook(intent.id);
  intent.scenario = outcome;
  intent.updatedAt = new Date().toISOString();

  if (outcome === 'success') {
    if (defaultScenario === 'success') {
      intent.status = 'paid';
      intent.resolvedAt = intent.updatedAt;
      return 'auto-success';
    }
    if (defaultScenario === 'failure') {
      intent.status = 'canceled';
      intent.resolvedAt = intent.updatedAt;
      return 'auto-failure';
    }
    intent.status = 'pending';
    intent.resolvedAt = null;
    return 'manual';
  }

  if (outcome === 'failure') {
    intent.status = 'canceled';
    intent.resolvedAt = intent.updatedAt;
    return 'failure';
  }
  if (outcome === 'error') {
    intent.status = 'failed';
    intent.resolvedAt = intent.updatedAt;
    return 'error';
  }
  if (outcome === 'back') {
    intent.status = 'pending';
    intent.resolvedAt = null;
    return 'back';
  }
  return 'noop';
}

app.get('/simulate/:intentId/redirect', (req, res) => {
  const intent = loadIntent(req, res);
  if (!intent) return;
  const outcome = String(req.query?.result || '').toLowerCase();
  if (!['success', 'failure', 'error', 'back'].includes(outcome)) {
    return res.redirect(`/simulate/${encodeURIComponent(intent.id)}`);
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

  cancelScheduledWebhook(intent.id);

  if (paymentMode === 'default') {
    trigger = applyOutcome(intent, outcome);
  } else if (paymentMode === 'yes') {
    intent.status = 'paid';
    intent.updatedAt = new Date().toISOString();
    intent.resolvedAt = intent.updatedAt;
    trigger = 'manual-confirm-now';
  } else if (paymentMode === 'delay') {
    intent.status = 'pending';
    intent.updatedAt = new Date().toISOString();
    intent.resolvedAt = null;
    const seconds = Number.isFinite(delayParam) && delayParam > 0 ? Math.round(delayParam) : 30;
    const timer = setTimeout(() => {
      intent.status = 'paid';
      intent.updatedAt = new Date().toISOString();
      intent.resolvedAt = intent.updatedAt;
      if (shouldSendWebhook) {
        scheduleWebhook(intent, 'manual-confirm-delay');
      }
    }, seconds * 1000);
    webhookTimers.set(intent.id, timer);
    trigger = 'manual-confirm-delay';
  } else if (paymentMode === 'no') {
    intent.status = 'pending';
    intent.updatedAt = new Date().toISOString();
    intent.resolvedAt = null;
    trigger = 'manual-keep-pending';
  }

  if (paymentMode !== 'delay') {
    if (shouldSendWebhook && intent.status !== 'pending') {
      const skip = new Set(['back', 'manual', 'noop', 'manual-keep-pending']);
      const label = trigger && !skip.has(trigger) ? `simulate-${trigger}` : 'simulate-manual';
      scheduleWebhook(intent, label);
    }
  }

  let target = intent.payload?.returnUrl || '';
  if (outcome === 'failure') {
    target = buildReturnUrl(intent, 'failure');
  } else if (outcome === 'error') {
    target = intent.payload?.errorUrl || intent.payload?.returnUrl;
  } else if (outcome === 'back') {
    target = intent.payload?.backUrl || intent.payload?.returnUrl;
  } else if (intent.status === 'canceled') {
    target = intent.payload?.backUrl || intent.payload?.returnUrl;
  } else if (intent.status === 'failed') {
    target = intent.payload?.errorUrl || intent.payload?.returnUrl;
  }

  if (!target) {
    res.send(htmlLayout('Résultat inattendu', `<p>Impossible de déterminer l’URL de retour.</p>`));
    return;
  }
  res.redirect(target);
});

// Helper to inspect stored intents
app.get('/intents.json', (_req, res) => {
  res.json({
    webhookTarget: WEBHOOK_TARGET || null,
    intents: Array.from(intents.values())
  });
});

app.listen(PORT, HOST, () => {
  console.log(`[stub_helloasso] listening on ${BASE_URL}`);
  console.log('[stub_helloasso] OAuth token endpoint: POST /oauth2/token');
  console.log('[stub_helloasso] Checkout intent endpoint: POST /v5/organizations/:slug/checkout-intents');
  if (WEBHOOK_TARGET) {
    console.log(`[stub_helloasso] Webhook target: ${WEBHOOK_TARGET}`);
  } else {
    console.log('[stub_helloasso] Webhook relay disabled (set HELLOASSO_WEBHOOK_URL or HELLOASSO_WEBHOOK).');
  }
});
