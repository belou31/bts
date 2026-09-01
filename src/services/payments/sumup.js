// src/services/payments/sumup.js

const DEFAULT_API_BASE = 'https://api.sumup.com/v0.1';
const DEFAULT_TOKEN_URL = 'https://api.sumup.com/token';

function apiBase() {
  const base = String(process.env.SUMUP_API_BASE || DEFAULT_API_BASE).trim();
  return base ? base.replace(/\/+$/, '') : DEFAULT_API_BASE;
}

function tokenUrl() {
  return String(process.env.SUMUP_TOKEN_URL || DEFAULT_TOKEN_URL).trim() || DEFAULT_TOKEN_URL;
}

function assertEnv() {
  const miss = [];
  if (!process.env.SUMUP_API_KEY) {
    if (!process.env.SUMUP_CLIENT_ID) miss.push('SUMUP_CLIENT_ID');
    if (!process.env.SUMUP_CLIENT_SECRET) miss.push('SUMUP_CLIENT_SECRET');
  }
  if (!process.env.SUMUP_MERCHANT_CODE && !process.env.SUMUP_PAY_TO_EMAIL) {
    miss.push('SUMUP_MERCHANT_CODE or SUMUP_PAY_TO_EMAIL');
  }
  if (miss.length) throw new Error('SumUp env missing: ' + miss.join(', '));
}

async function getAccessToken() {
  assertEnv();
  // API Key auth: use directly as Bearer token (no OAuth step)
  //
  // .trim() : une clé collée dans .env emporte souvent un espace final, et un
  // fichier en CRLF y ajoute un \r. L'en-tête « Bearer <clé>\r » est alors
  // malformé et SumUp répond 401 — indiscernable d'une clé révoquée.
  if (process.env.SUMUP_API_KEY) {
    return String(process.env.SUMUP_API_KEY).trim();
  }
  // OAuth client_credentials flow
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: String(process.env.SUMUP_CLIENT_ID || '').trim(),
    client_secret: String(process.env.SUMUP_CLIENT_SECRET || '').trim()
  });
  if (process.env.SUMUP_OAUTH_SCOPES) {
    body.set('scope', process.env.SUMUP_OAUTH_SCOPES);
  }
  const r = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`SumUp oauth ${r.status} ${JSON.stringify(j)}`);
  return j.access_token;
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
  if (process.env.SUMUP_RETURN_URL) return process.env.SUMUP_RETURN_URL;
  const base = appBase();
  return base ? `${base}/pay/return` : '';
}

function defaultCancelUrl() {
  if (process.env.SUMUP_CANCEL_URL) return process.env.SUMUP_CANCEL_URL;
  const base = appBase();
  return base ? `${base}/pay/back` : '';
}

function defaultErrorUrl() {
  if (process.env.SUMUP_ERROR_URL) return process.env.SUMUP_ERROR_URL;
  const base = appBase();
  return base ? `${base}/pay/error` : '';
}

function buildReturnUrls(order, overrides = {}) {
  const orderId = order?._id ? String(order._id) : '';
  const returnUrl = addOrderIdParam(overrides.returnUrl || defaultReturnUrl(), orderId);
  const cancelUrl = addOrderIdParam(overrides.backUrl || defaultCancelUrl(), orderId);
  const errorUrl = addOrderIdParam(overrides.errorUrl || defaultErrorUrl(), orderId);
  return {
    returnUrl,
    backUrl: cancelUrl,
    errorUrl
  };
}

function totalAmountFromOrder(order) {
  const cents = Number(order.totalCents || 0);
  if (!Number.isFinite(cents) || cents <= 0) throw new Error('totalAmount invalid');
  return Number((cents / 100).toFixed(2));
}

function normalizeStatus(input, fallback) {
  const raw = String(input || fallback || '').trim().toUpperCase();
  if (!raw) return '';
  if (raw === 'PAID' || raw === 'SUCCESS' || raw === 'SUCCESSFUL' || raw === 'PAID_OUT') return 'paid';
  if (raw === 'PENDING' || raw === 'WAITING') return 'pending';
  if (raw === 'FAILED' || raw === 'DECLINED' || raw === 'CANCELLED' || raw === 'CANCELED') return 'failed';
  if (raw === 'REFUNDED') return 'refunded';
  return raw.toLowerCase();
}

function buildCheckoutPayload({ order, urls }) {
  const checkoutReference = `${process.env.SUMUP_CHECKOUT_PREFIX || 'bts'}-${order._id}`;
  const currency = String(order.currency || process.env.SUMUP_CURRENCY || 'EUR').toUpperCase();
  const payload = {
    checkout_reference: checkoutReference,
    merchant_code: process.env.SUMUP_MERCHANT_CODE || undefined,
    pay_to_email: process.env.SUMUP_PAY_TO_EMAIL || undefined,
    amount: totalAmountFromOrder(order),
    currency,
    description: order.itemName || `Order ${order._id}`,
    return_url: urls.returnUrl || undefined,
    cancel_url: urls.backUrl || undefined,
    failure_url: urls.errorUrl || undefined,
    callback_url: process.env.SUMUP_CALLBACK_URL || process.env.SUMUP_WEBHOOK_URL || process.env.HELLOASSO_WEBHOOK_URL || undefined,
    payment_type: process.env.SUMUP_PAYMENT_TYPE || undefined,
    custom_id: String(order._id || ''),
    hosted_checkout: { enabled: true }
  };
  // Remove undefined keys
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === '') {
      delete payload[key];
    }
  }
  return payload;
}

async function createCheckoutIntent({ order, returnUrl, backUrl, errorUrl }) {
  const token = await getAccessToken();
  // URLs are already built (with oid) by the caller — pass them through directly
  const urls = { returnUrl: returnUrl || '', backUrl: backUrl || '', errorUrl: errorUrl || '' };
  const payload = buildCheckoutPayload({ order, urls });

  const r = await fetch(`${apiBase()}/checkouts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('[sumup] payload sent:', JSON.stringify(payload));
    if (r.status === 401) {
      // 401 = la requête est bien partie, SumUp refuse l'identité. Ce n'est
      // donc jamais le panier ni les URLs de retour : inutile de les relire.
      console.error('[sumup] 401 — identifiants refusés. À vérifier, dans cet ordre :');
      console.error(`[sumup]   mode d'auth : ${process.env.SUMUP_API_KEY ? 'SUMUP_API_KEY' : 'OAuth client_credentials'}`);
      console.error(`[sumup]   api base    : ${apiBase()}`);
      console.error(`[sumup]   merchant    : ${process.env.SUMUP_MERCHANT_CODE || '(non défini)'}`);
      console.error('[sumup]   diagnostic  : node scripts/00-system-management/check-payment-provider.js');
    }
    throw new Error(`SumUp checkout ${r.status} ${JSON.stringify(j)}`);
  }
  // SumUp sometimes only returns links on GET, not POST — fetch to get the real checkout URL
  let jGet = j;
  if (j.id && !j.checkout_url && !j.links?.length) {
    try {
      const rGet = await fetch(`${apiBase()}/checkouts/${encodeURIComponent(j.id)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (rGet.ok) {
        jGet = await rGet.json().catch(() => j);
      }
    } catch { /* ignore, fall back to POST response */ }
  }

  const resolvedCheckout = { ...j, ...jGet };
  const hostedUrl = resolvedCheckout.id ? `https://pay.sumup.com/b2c/${encodeURIComponent(resolvedCheckout.id)}` : '';
  const resolvedRedirectUrl =
    resolvedCheckout.hosted_checkout_url ||
    resolvedCheckout.hosted_checkout?.url ||
    resolvedCheckout.checkout_url ||
    resolvedCheckout.checkout_redirect_url ||
    (resolvedCheckout.links && resolvedCheckout.links.find(l => l.rel === 'checkout')?.href) ||
    hostedUrl;
  return {
    redirectUrl: resolvedRedirectUrl,
    id: resolvedCheckout.id || resolvedCheckout.checkout_reference || payload.checkout_reference,
    raw: resolvedCheckout,
    checkoutReference: resolvedCheckout.checkout_reference || payload.checkout_reference,
    providerOrderId: resolvedCheckout.transaction_code || resolvedCheckout.transaction_id || resolvedCheckout.id || resolvedCheckout.checkout_reference || payload.checkout_reference
  };
}

async function getCheckoutIntent(intentId) {
  const token = await getAccessToken();
  const ref = encodeURIComponent(intentId);
  const r = await fetch(`${apiBase()}/checkouts/${ref}`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`SumUp get checkout ${r.status} ${JSON.stringify(j)}`);
  return {
    status: j.status || '',
    metadata: { custom_id: j.custom_id || j.checkout_reference || '' },
    payer: j.customer || {},
    providerOrderId: j.transaction_code || j.transaction_id || j.id || j.checkout_reference || '',
    raw: j
  };
}

async function getCheckoutStatus(intentId) {
  const { status } = await getCheckoutIntent(intentId);
  return status;
}

const provider = {
  id: 'sumup',
  label: 'SumUp',
  uxCapabilities: ['widget', 'redirect'],
  docs: {
    env: [
      'PAYMENT_PROVIDER',
      'SUMUP_API_BASE',
      'SUMUP_TOKEN_URL',
      'SUMUP_CLIENT_ID',
      'SUMUP_CLIENT_SECRET',
      'SUMUP_MERCHANT_CODE',
      'SUMUP_PAY_TO_EMAIL',
      'SUMUP_CURRENCY',
      'SUMUP_RETURN_URL',
      'SUMUP_CANCEL_URL',
      'SUMUP_ERROR_URL',
      'SUMUP_CALLBACK_URL',
      'SUMUP_WEBHOOK_URL',
      'SUMUP_OAUTH_SCOPES',
      'SUMUP_PAYMENT_TYPE',
      'SUMUP_CHECKOUT_PREFIX'
    ],
    stubCommand: 'npm run sumup:stub',
    defaultApiBase: DEFAULT_API_BASE,
    webhookDriven: true,
    notes: [
      'Uses OAuth client credentials against the SumUp API.',
      'Requires either SUMUP_MERCHANT_CODE or SUMUP_PAY_TO_EMAIL.',
      'Supports local development through the SumUp stub by overriding SUMUP_API_BASE and SUMUP_TOKEN_URL.'
    ]
  },
  buildReturnUrls,
  createCheckoutIntent,
  getCheckoutIntent,
  getCheckoutStatus,
  normalizeStatus
};

export default provider;
