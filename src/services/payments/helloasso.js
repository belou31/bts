// src/services/payments/helloasso.js

const API_DEFAULT = 'https://api.helloasso.com';

function apiBase() {
  const base = (process.env.HELLOASSO_API_URL || API_DEFAULT).trim();
  return base ? base.replace(/\/+$/, '') : API_DEFAULT;
}

function assertEnv() {
  const miss = [];
  if (!process.env.HELLOASSO_ORG_SLUG) miss.push('HELLOASSO_ORG_SLUG');
  if (!process.env.HELLOASSO_CLIENT_ID) miss.push('HELLOASSO_CLIENT_ID');
  if (!process.env.HELLOASSO_CLIENT_SECRET) miss.push('HELLOASSO_CLIENT_SECRET');
  if (miss.length) throw new Error('HelloAsso env manquant: ' + miss.join(', '));
}

function oauthUrl() {
  return `${apiBase()}/oauth2/token`;
}

function apiV5() {
  return `${apiBase()}/v5`;
}

async function getAccessToken() {
  assertEnv();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.HELLOASSO_CLIENT_ID,
    client_secret: process.env.HELLOASSO_CLIENT_SECRET
  });
  const r = await fetch(oauthUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HelloAsso oauth ${r.status} ${JSON.stringify(j)}`);
  return j.access_token;
}

function getOffsetDate(inDate, inMthShift) {
  const myDate = new Date();
  myDate.setFullYear(inDate.getFullYear());
  myDate.setDate(1);
  myDate.setMonth(inDate.getMonth() + inMthShift + 1);
  myDate.setDate(0);
  const myLocal = Math.min(inDate.getDate(), myDate.getDate(), 27);
  myDate.setMonth(inDate.getMonth() + inMthShift);
  myDate.setDate(myLocal);
  return myDate;
}

function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultReturnUrl() {
  return process.env.HELLOASSO_RETURN_URL || `${process.env.APP_URL || ''}/pay/return`;
}

function defaultBackUrl() {
  return process.env.HELLOASSO_BACK_URL || defaultReturnUrl().replace('/pay/return', '/pay/back');
}

function defaultErrorUrl() {
  return process.env.HELLOASSO_ERROR_URL || defaultReturnUrl().replace('/pay/return', '/pay/error');
}

function withOrderId(url, orderId) {
  if (!url) return '';
  if (!orderId) return url;
  const param = `oid=${encodeURIComponent(String(orderId))}`;
  return url.includes('?') ? `${url}&${param}` : `${url}?${param}`;
}

function buildReturnUrls(order, overrides = {}) {
  const returnUrl = overrides.returnUrl || defaultReturnUrl();
  const backUrl = overrides.backUrl || defaultBackUrl();
  const errorUrl = overrides.errorUrl || defaultErrorUrl();
  const orderId = order?._id ? String(order._id) : '';
  return {
    returnUrl: withOrderId(returnUrl, orderId),
    backUrl: withOrderId(backUrl, orderId),
    errorUrl: withOrderId(errorUrl, orderId)
  };
}

function normalizeStatus(input, fallback) {
  let raw = input;
  if (raw && typeof raw === 'object') {
    raw = raw.status || raw.state || raw.code || raw.result || raw.paymentStatus ||
      (raw.data && (raw.data.status || raw.data.state || raw.data.code)) || '';
  }
  raw = String(raw || fallback || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'payment_succeeded' || raw === 'success' || raw === 'succeeded' || raw === 'ok') return 'succeeded';
  if (raw === 'paid' || raw === 'payment_accepted' || raw === 'processed') return 'paid';
  if (raw.startsWith('authoriz')) return 'authorized';
  if (raw === 'payment_failed' || raw === 'failed') return 'failed';
  if (raw === 'canceled') return 'canceled';
  if (raw === 'payment_refunded' || raw === 'refunded' || raw === 'refund') return 'refunded';
  return raw;
}

async function createCheckoutIntent({ order, returnUrl, backUrl, errorUrl }) {
  const token = await getAccessToken();
  const urls = buildReturnUrls(order, { returnUrl, backUrl, errorUrl });

  const n = Math.max(1, Number(order.installments || order.paymentSplit || 1));
  const total = Number(order.totalCents || 0);
  if (!total || total < 0) throw new Error('totalAmount invalid');

  const itemName = order.itemName || 'MyOrder';

  const base = Math.floor(total / n);
  const remainder = total - base * n;
  const initialAmount = base + remainder;

  let terms = [];
  if (n > 1) {
    const start = new Date();
    for (let i = 1; i < n; i++) {
      const due = getOffsetDate(start, i);
      terms.push({ amount: base, date: ymdLocal(due) });
    }
    if (terms.some(t => t.amount < 1000)) terms = [];
  }

  const payload = {
    totalAmount: total,
    initialAmount,
    containsDonation: false,
    itemName,
    payer: {
      firstName: order.payerFirstName || '',
      lastName: order.payerLastName || '',
      email: order.payerEmail || ''
    },
    items: Array.isArray(order.lines) ? order.lines.map(l => {
      const isVirtual = /-Z\d{3,}$/i.test(String(l.seatId || ''));
      const place = isVirtual ? (l.zoneKey || '') : (l.seatId || l.zoneKey || '');
      return {
        name: `${place} • ${l.tariffCode}`,
        amount: Number(l.priceCents || 0),
        quantity: 1
      };
    }) : [],
    returnUrl: urls.returnUrl,
    backUrl: urls.backUrl,
    errorUrl: urls.errorUrl,
    metadata: {
      orderNo: String(order.orderNo || order._id || ''),
      orderId: String(order._id || '')
    }
  };
  if (terms.length) payload.terms = terms;

  if ((process.env.HELLOASSO_ENV || '').includes('sandbox')) {
    console.log('[helloasso] payload', JSON.stringify(payload));
  }

  const orgSlug = process.env.HELLOASSO_ORG_SLUG;
  const url = `${apiV5()}/organizations/${encodeURIComponent(orgSlug)}/checkout-intents`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('[helloasso] payload sent:', JSON.stringify(payload));
    throw new Error(`HelloAsso checkout ${r.status} ${JSON.stringify(j)}`);
  }
  return {
    redirectUrl: j.redirectUrl || j.redirectUri || j.url || '',
    raw: j,
    id: j.id || j.checkoutIntentId || j.intentId || null,
    providerOrderId: extractProviderOrderIdFromIntent(j)
  };
}

function extractProviderOrderIdFromIntent(j) {
  return (
    j?.orderId ||
    j?.order?.id ||
    j?.payment?.orderId ||
    j?.cart?.orderId ||
    null
  );
}

async function getCheckoutIntent(intentId) {
  const token = await getAccessToken();
  const headers = { 'Authorization': `Bearer ${token}` };
  const orgSlug = process.env.HELLOASSO_ORG_SLUG;

  let r = await fetch(`${apiV5()}/checkout-intents/${encodeURIComponent(intentId)}`, { headers });
  if (r.status === 404 || r.status === 403) {
    r = await fetch(`${apiV5()}/organizations/${encodeURIComponent(orgSlug)}/checkout-intents/${encodeURIComponent(intentId)}`, { headers });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HelloAsso get intent ${r.status} ${JSON.stringify(j)}`);

  return {
    status: j.status || j.state || j.paymentStatus || '',
    metadata: j.metadata || {},
    payer: j.payer || {},
    providerOrderId: extractProviderOrderIdFromIntent(j),
    raw: j
  };
}

async function getCheckoutStatus(intentId) {
  const { status } = await getCheckoutIntent(intentId);
  return status;
}

const provider = {
  id: 'helloasso',
  label: 'HelloAsso',
  docs: {
    env: [
      'PAYMENT_PROVIDER',
      'HELLOASSO_API_URL',
      'HELLOASSO_ORG_SLUG',
      'HELLOASSO_CLIENT_ID',
      'HELLOASSO_CLIENT_SECRET',
      'HELLOASSO_RETURN_URL',
      'HELLOASSO_BACK_URL',
      'HELLOASSO_ERROR_URL',
      'HELLOASSO_WEBHOOK_URL',
      'HELLOASSO_STUB_WEBHOOK_URL',
      'HELLOASSO_ENV'
    ],
    stubCommand: 'npm run helloasso:stub',
    defaultApiBase: API_DEFAULT,
    webhookDriven: true,
    notes: [
      'Uses OAuth client credentials against the HelloAsso API.',
      'Supports local development through the HelloAsso stub by overriding HELLOASSO_API_URL.'
    ]
  },
  buildReturnUrls,
  createCheckoutIntent,
  getCheckoutIntent,
  getCheckoutStatus,
  normalizeStatus
};

export default provider;
