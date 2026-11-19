// stub_mollie/server.js
// Standalone Mollie payments stub for local development.
// Emulates POST /v2/payments, GET /v2/payments/{id}, and a hosted checkout simulation page.
// Webhook format: POST to BTS with body "id=tr_xxxx" (application/x-www-form-urlencoded).

import express from 'express';
import crypto from 'node:crypto';

const app = express();
const HOST = process.env.MOLLIE_STUB_HOST || '127.0.0.1';
const PORT = Number(process.env.MOLLIE_STUB_PORT || 3025);
const BASE_URL = `http://${HOST}:${PORT}`;
const WEBHOOK_TARGET = process.env.MOLLIE_WEBHOOK_URL || 'http://localhost:8080/pay/webhook';
const WEBHOOK_DELAY_MS = Number.isFinite(Number(process.env.MOLLIE_STUB_WEBHOOK_DELAY_MS))
  ? Number(process.env.MOLLIE_STUB_WEBHOOK_DELAY_MS)
  : 400;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const payments = new Map();  // id → payment object
let defaultScenario = 'manual'; // manual | success | failure

function paymentId() {
  return `tr_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatAmount(value, currency) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)} ${escapeHtml(String(currency || 'EUR').toUpperCase())}` : '—';
}

// ── Webhook ──────────────────────────────────────────────────────────────────

async function sendWebhook(payment, trigger = 'manual') {
  if (!WEBHOOK_TARGET) return;
  const record = { trigger, status: payment.status, at: nowIso() };
  try {
    // Mollie sends form-urlencoded: id=tr_xxxx
    const res = await fetch(WEBHOOK_TARGET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: payment.id }).toString()
    });
    record.httpStatus = res.status;
    record.ok = res.ok;
  } catch (err) {
    record.ok = false;
    record.error = err?.message || String(err);
    console.warn('[stub_mollie] webhook failed:', record.error);
  }
  payment.webhookHistory = [...(payment.webhookHistory || []).slice(-9), record];
  payment.webhookLastSentAt = record.at;
}

const webhookTimers = new Map();

function scheduleWebhook(payment, trigger = 'manual') {
  if (!WEBHOOK_TARGET || payment.status === 'open' || payment.status === 'pending') return;
  const id = payment.id;
  if (webhookTimers.has(id)) { clearTimeout(webhookTimers.get(id)); }
  const delay = WEBHOOK_DELAY_MS >= 0 ? WEBHOOK_DELAY_MS : 400;
  webhookTimers.set(id, setTimeout(async () => {
    webhookTimers.delete(id);
    await sendWebhook(payment, trigger);
  }, delay));
}

// ── Mollie API endpoints ─────────────────────────────────────────────────────

// POST /v2/payments
app.post('/v2/payments', (req, res) => {
  const body = typeof req.body === 'object' ? req.body : {};
  const id = paymentId();
  const amountObj = body.amount && typeof body.amount === 'object' ? body.amount : {};
  const payment = {
    resource:    'payment',
    id,
    mode:        'test',
    status:      'open',
    createdAt:   nowIso(),
    updatedAt:   nowIso(),
    amount:      { currency: String(amountObj.currency || 'EUR').toUpperCase(), value: String(amountObj.value || '0.00') },
    description: String(body.description || ''),
    redirectUrl: String(body.redirectUrl || ''),
    cancelUrl:   String(body.cancelUrl   || ''),
    webhookUrl:  String(body.webhookUrl  || ''),
    method:      body.method || null,
    metadata:    body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
    webhookHistory: [],
    webhookLastSentAt: null,
    scenario:    defaultScenario,
    _links: {
      self:     { href: `${BASE_URL}/v2/payments/${id}`, type: 'application/hal+json' },
      checkout: { href: `${BASE_URL}/simulate/${id}`,   type: 'text/html' },
      dashboard:{ href: `${BASE_URL}/`,                 type: 'text/html' }
    }
  };
  payments.set(id, payment);

  if (defaultScenario === 'success') {
    payment.status = 'paid';
    payment.paidAt = payment.createdAt;
    scheduleWebhook(payment, 'auto-success');
  } else if (defaultScenario === 'failure') {
    payment.status = 'failed';
    scheduleWebhook(payment, 'auto-failure');
  }

  res.status(201).json(payment);
});

// GET /v2/payments/:id
app.get('/v2/payments/:id', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json({ status: 404, title: 'Not Found', detail: `No payment found with id ${req.params.id}` });
  res.json(payment);
});

// ── Admin: change payment status ─────────────────────────────────────────────

function redirectBack(req, res, fallback = '/') {
  const ref = req.get('Referer') || '';
  try {
    const u = new URL(ref);
    if (u.host === req.get('host')) { res.redirect(u.pathname + u.search); return; }
  } catch {}
  res.redirect(fallback);
}

app.post('/payments/:id/status', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).send('Not found');
  const status = String(req.body?.status || '').toLowerCase();
  if (!['open', 'pending', 'paid', 'failed', 'expired', 'canceled'].includes(status)) {
    return redirectBack(req, res);
  }
  payment.status = status;
  payment.updatedAt = nowIso();
  if (status === 'paid') payment.paidAt = payment.updatedAt;
  scheduleWebhook(payment, 'admin-status');
  redirectBack(req, res);
});

app.post('/default-scenario', (req, res) => {
  const s = String(req.body?.scenario || '').toLowerCase();
  if (['manual', 'success', 'failure'].includes(s)) defaultScenario = s;
  redirectBack(req, res);
});

// ── Simulate checkout page ────────────────────────────────────────────────────

app.get('/simulate/:id', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) {
    res.status(404).send(layout('Inconnu', '<p>Paiement introuvable.</p>'));
    return;
  }
  const methods = Array.isArray(payment.method)
    ? payment.method.join(', ')
    : (payment.method || 'tous');

  const body = `
    <h1>Simuler le paiement</h1>
    <p>ID : <code>${escapeHtml(payment.id)}</code> — Statut : <span class="badge ${escapeHtml(payment.status)}">${escapeHtml(payment.status)}</span></p>
    <p>Montant : <strong>${escapeHtml(payment.amount.value)} ${escapeHtml(payment.amount.currency)}</strong></p>
    <p class="muted">Description : ${escapeHtml(payment.description)}</p>
    <p class="muted">Méthodes : ${escapeHtml(methods)} — Scénario : <strong>${escapeHtml(defaultScenario)}</strong></p>

    <section>
      <h2>Confirmer &amp; retour vers BTS</h2>
      <form method="get" action="/simulate/${escapeHtml(payment.id)}/redirect">
        <input type="hidden" name="result" value="success">
        <fieldset>
          <legend>Résultat du paiement :</legend>
          <label><input type="radio" name="paymentMode" value="default" checked> Scénario par défaut (<strong>${escapeHtml(defaultScenario)}</strong>)</label>
          <label><input type="radio" name="paymentMode" value="yes"> Paiement confirmé</label>
          <label><input type="radio" name="paymentMode" value="delay"> Confirmé après <input type="number" name="delay" value="30" min="1" style="width:4rem"> s</label>
          <label><input type="radio" name="paymentMode" value="no"> Rester en attente</label>
        </fieldset>
        <fieldset>
          <legend>Webhook :</legend>
          <label><input type="radio" name="webhookMode" value="yes" checked> Envoyer</label>
          <label><input type="radio" name="webhookMode" value="no"> Ne pas envoyer</label>
        </fieldset>
        <button type="submit">Simuler CONFIRMATION</button>
      </form>
    </section>

    <section>
      <h2>Autres redirections</h2>
      <p>
        <a href="/simulate/${escapeHtml(payment.id)}/redirect?result=cancel">↩ Annulation (cancelUrl)</a><br>
        <a href="/simulate/${escapeHtml(payment.id)}/redirect?result=failure">✕ Échec</a>
      </p>
    </section>
    <p class="muted">redirectUrl : ${escapeHtml(payment.redirectUrl || '(non défini)')}</p>
    <p><a href="/">← Tableau de bord</a></p>
    <script>
      (function(){
        const form = document.querySelector('form');
        if (!form) return;
        const delayInput = form.querySelector('input[name="delay"]');
        form.querySelectorAll('input[name="paymentMode"]').forEach(r =>
          r.addEventListener('change', () => {
            if (delayInput) delayInput.disabled = r.value !== 'delay';
          })
        );
        if (delayInput) delayInput.disabled = true;
      })();
    </script>
  `;
  res.send(layout('Simulation Mollie', body));
});

app.get('/simulate/:id/redirect', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) { res.status(404).send(layout('Inconnu', '<p>Paiement introuvable.</p>')); return; }

  const result = String(req.query?.result || 'success').toLowerCase();
  let paymentMode = String(req.query?.paymentMode || 'default').toLowerCase();
  const webhookMode = String(req.query?.webhookMode || 'yes').toLowerCase();
  const shouldWebhook = webhookMode !== 'no';
  const delayParam = Number(req.query?.delay || 30);

  if (webhookTimers.has(payment.id)) {
    clearTimeout(webhookTimers.get(payment.id));
    webhookTimers.delete(payment.id);
  }

  if (result === 'cancel') {
    payment.status = 'canceled';
    payment.updatedAt = nowIso();
    const target = payment.cancelUrl || payment.redirectUrl || '/';
    return res.redirect(appendState(target, 'canceled', payment.id));
  }

  if (result === 'failure') {
    payment.status = 'failed';
    payment.updatedAt = nowIso();
    if (shouldWebhook) scheduleWebhook(payment, 'simulate-failure');
    const target = payment.redirectUrl || '/';
    return res.redirect(appendState(target, 'failed', payment.id));
  }

  // result === 'success'
  if (paymentMode === 'default') {
    paymentMode = defaultScenario === 'failure' ? 'no' : defaultScenario === 'success' ? 'yes' : 'no';
  }

  if (paymentMode === 'yes') {
    payment.status = 'paid';
    payment.paidAt = nowIso();
    payment.updatedAt = payment.paidAt;
    if (shouldWebhook) scheduleWebhook(payment, 'simulate-paid');
  } else if (paymentMode === 'delay') {
    payment.status = 'pending';
    payment.updatedAt = nowIso();
    const seconds = Number.isFinite(delayParam) && delayParam > 0 ? delayParam : 30;
    webhookTimers.set(payment.id, setTimeout(async () => {
      webhookTimers.delete(payment.id);
      payment.status = 'paid';
      payment.paidAt = nowIso();
      payment.updatedAt = payment.paidAt;
      if (shouldWebhook) await sendWebhook(payment, 'simulate-delay-paid');
    }, seconds * 1000));
  } else {
    payment.status = 'open';
    payment.updatedAt = nowIso();
  }

  const target = payment.redirectUrl || '/';
  res.redirect(appendState(target, payment.status, payment.id));
});

function appendState(url, status, id) {
  if (!url) return '/';
  const params = new URLSearchParams({ id, status });
  return url.includes('?') ? `${url}&${params}` : `${url}?${params}`;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  const rows = Array.from(payments.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(p => {
      const status = escapeHtml(p.status);
      const lastWebhook = p.webhookLastSentAt || '—';
      return `
        <tr>
          <td><a href="/simulate/${escapeHtml(p.id)}"><code>${escapeHtml(p.id)}</code></a></td>
          <td><span class="badge ${status}">${status}</span></td>
          <td>${formatAmount(p.amount?.value, p.amount?.currency)}</td>
          <td class="muted">${escapeHtml(p.description || '—')}</td>
          <td>
            <form method="post" action="/payments/${escapeHtml(p.id)}/status" style="display:inline">
              <input type="hidden" name="status" value="paid"><button>Payé</button>
            </form>
            <form method="post" action="/payments/${escapeHtml(p.id)}/status" style="display:inline">
              <input type="hidden" name="status" value="failed"><button>Échoué</button>
            </form>
            <form method="post" action="/payments/${escapeHtml(p.id)}/status" style="display:inline">
              <input type="hidden" name="status" value="open"><button>Reset</button>
            </form>
          </td>
          <td class="muted" style="font-size:0.82rem">${escapeHtml(String(lastWebhook))}</td>
        </tr>
      `;
    }).join('');

  const table = rows
    ? `<table>
        <thead><tr><th>ID</th><th>Statut</th><th>Montant</th><th>Description</th><th>Actions</th><th>Dernier webhook</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : '<p class="muted">Aucun paiement pour le moment.</p>';

  const body = `
    <h1>Mollie Stub</h1>
    <p class="muted">API sur <code>${escapeHtml(BASE_URL)}/v2</code></p>
    <form method="post" action="/default-scenario" id="scenario-form">
      <div class="pill">
        <label><input type="radio" name="scenario" value="manual"${defaultScenario === 'manual' ? ' checked' : ''}> Manuel</label>
        <label><input type="radio" name="scenario" value="success"${defaultScenario === 'success' ? ' checked' : ''}> Succès auto</label>
        <label><input type="radio" name="scenario" value="failure"${defaultScenario === 'failure' ? ' checked' : ''}> Échec auto</label>
      </div>
    </form>
    ${WEBHOOK_TARGET ? `<p class="muted">Webhook → <code>${escapeHtml(WEBHOOK_TARGET)}</code></p>` : '<p class="muted">Webhook désactivé.</p>'}
    ${table}
    <script>
      document.getElementById('scenario-form')?.querySelectorAll('input[name="scenario"]')
        .forEach(r => r.addEventListener('change', () => document.getElementById('scenario-form').submit()));
    </script>
  `;
  res.send(layout('Mollie Stub', body));
});

app.get('/payments.json', (_req, res) => {
  res.json({ webhookTarget: WEBHOOK_TARGET || null, payments: Array.from(payments.values()) });
});

// ── Layout ────────────────────────────────────────────────────────────────────

function layout(title, body) {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 32px; }
    h1, h2 { margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { border: 1px solid #d0d7de33; padding: 8px 12px; text-align: left; }
    th { background: #f6f8fa22; }
    code { background: #d0d7de33; padding: 2px 5px; border-radius: 4px; }
    .badge { display:inline-block; padding:3px 8px; border-radius:999px; font-size:.75rem; }
    .badge.paid,.badge.authorized { background:#22c55e33; color:#14532D; }
    .badge.open,.badge.pending    { background:#facc1533; color:#92400E; }
    .badge.failed,.badge.expired,.badge.canceled { background:#f9731633; color:#7C2D12; }
    .muted { color:#666; font-size:.85rem; }
    .pill  { border:1px solid #d0d7de66; padding:6px 10px; border-radius:12px; display:inline-block; margin-bottom:12px; }
    section { margin: 20px 0; }
    fieldset { border:1px solid #d0d7de66; padding:8px 12px; border-radius:8px; margin:8px 0; }
    fieldset label { display:block; margin:4px 0; }
    button { cursor:pointer; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`[stub_mollie] listening on ${BASE_URL}`);
  console.log(`[stub_mollie] Payments API: POST/GET ${BASE_URL}/v2/payments`);
  if (WEBHOOK_TARGET) {
    console.log(`[stub_mollie] Webhook target: ${WEBHOOK_TARGET} (form-urlencoded: id=tr_xxxx)`);
  } else {
    console.log('[stub_mollie] Webhook relay disabled (set MOLLIE_WEBHOOK_URL).');
  }
});
