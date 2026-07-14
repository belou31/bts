// src/services/payments/mollie.js

const DEFAULT_API_BASE = 'https://api.mollie.com/v2';

function apiBase() {
  return String(process.env.MOLLIE_API_BASE || DEFAULT_API_BASE).trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
}

function assertEnv() {
  if (!process.env.MOLLIE_API_KEY) throw new Error('MOLLIE_API_KEY is required');
}

function authHeaders() {
  assertEnv();
  return { 'Authorization': `Bearer ${process.env.MOLLIE_API_KEY}` };
}

function amountStr(totalCents) {
  const n = Number(totalCents);
  if (!Number.isFinite(n) || n <= 0) throw new Error('totalAmount invalid');
  return (n / 100).toFixed(2);
}

function addOrderIdParam(url, orderId) {
  if (!url) return '';
  if (!orderId) return url;
  const param = `oid=${encodeURIComponent(String(orderId))}`;
  return url.includes('?') ? `${url}&${param}` : `${url}?${param}`;
}

function appBase() {
  return String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
}

function defaultReturnUrl() {
  if (process.env.MOLLIE_RETURN_URL) return process.env.MOLLIE_RETURN_URL;
  const base = appBase();
  return base ? `${base}/pay/return` : '';
}

function defaultCancelUrl() {
  if (process.env.MOLLIE_CANCEL_URL) return process.env.MOLLIE_CANCEL_URL;
  const base = appBase();
  return base ? `${base}/pay/back` : '';
}

function buildReturnUrls(order, overrides = {}) {
  const orderId = order?._id ? String(order._id) : '';
  return {
    returnUrl: addOrderIdParam(overrides.returnUrl || defaultReturnUrl(), orderId),
    backUrl:   addOrderIdParam(overrides.backUrl   || defaultCancelUrl(), orderId),
    errorUrl:  addOrderIdParam(overrides.errorUrl  || defaultCancelUrl(), orderId)
  };
}

async function createCheckoutIntent({ order, returnUrl, backUrl }) {
  const headers = { ...authHeaders(), 'Content-Type': 'application/json' };
  const currency = String(order.currency || process.env.MOLLIE_CURRENCY || 'EUR').toUpperCase();

  // MOLLIE_METHODS: comma-separated list (e.g. "creditcard,wero"); empty = all methods shown
  const methods = process.env.MOLLIE_METHODS
    ? process.env.MOLLIE_METHODS.split(',').map(s => s.trim()).filter(Boolean)
    : null;

  const webhookUrl = process.env.MOLLIE_WEBHOOK_URL || '';

  const payload = {
    amount:      { currency, value: amountStr(order.totalCents) },
    description: order.itemName || `Order ${order._id}`,
    redirectUrl: returnUrl || '',
    cancelUrl:   backUrl || undefined,
    webhookUrl:  webhookUrl || undefined,
    method:      (methods && methods.length) ? methods : undefined,
    metadata:    { orderId: String(order._id) }
  };
  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined) delete payload[k];
  }

  const r = await fetch(`${apiBase()}/payments`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('[mollie] payload sent:', JSON.stringify(payload));
    throw new Error(`Mollie create payment ${r.status}: ${JSON.stringify(j)}`);
  }

  const checkoutUrl = j._links?.checkout?.href || '';
  return {
    redirectUrl:       checkoutUrl,
    id:                j.id,
    raw:               j,
    checkoutReference: j.id,
    providerOrderId:   j.id
  };
}

async function getCheckoutIntent(intentId) {
  const r = await fetch(`${apiBase()}/payments/${encodeURIComponent(intentId)}`, {
    headers: authHeaders()
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Mollie get payment ${r.status}: ${JSON.stringify(j)}`);
  return {
    status:         j.status || '',
    metadata:       j.metadata || {},
    payer:          {},
    providerOrderId: j.id || '',
    raw:            j
  };
}

async function getCheckoutStatus(intentId) {
  const { status } = await getCheckoutIntent(intentId);
  return status;
}

function normalizeStatus(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (raw === 'paid' || raw === 'authorized') return 'paid';
  if (raw === 'open' || raw === 'pending') return 'pending';
  if (raw === 'expired' || raw === 'canceled' || raw === 'failed') return 'failed';
  if (raw === 'refunded' || raw === 'charged_back') return 'refunded';
  return raw;
}

const provider = {
  id: 'mollie',
  label: 'Mollie',
  uxCapabilities: ['redirect'],
  docs: {
    env: [
      'PAYMENT_PROVIDER',
      'MOLLIE_API_BASE',
      'MOLLIE_API_KEY',
      'MOLLIE_CURRENCY',
      'MOLLIE_RETURN_URL',
      'MOLLIE_CANCEL_URL',
      'MOLLIE_WEBHOOK_URL',
      'MOLLIE_METHODS'
    ],
    stubCommand: 'npm run mollie:stub',
    defaultApiBase: DEFAULT_API_BASE,
    webhookDriven: true,
    notes: [
      'Uses API key auth (Bearer token) — no OAuth step needed.',
      'Webhook body is form-urlencoded: id=tr_xxxx. BTS fetches payment status from Mollie API upon receipt.',
      'Set MOLLIE_METHODS to a comma-separated list to restrict payment methods (e.g. "creditcard,wero").',
      'Wero is available in Germany and Belgium; France rollout expected mid/late 2026.'
    ]
  },
  buildReturnUrls,
  createCheckoutIntent,
  getCheckoutIntent,
  getCheckoutStatus,
  normalizeStatus
};

export default provider;
