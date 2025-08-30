// src/services/helloasso.js (ESM)
const API_BASE  = (process.env.HELLOASSO_API_URL || 'https://api.helloasso.com').replace(/\/+$/,'');
const OAUTH_URL = `${API_BASE}/oauth2/token`;
const API_V5    = `${API_BASE}/v5`;

const ORG_SLUG   = process.env.HELLOASSO_ORG_SLUG;
const CLIENT_ID  = process.env.HELLOASSO_CLIENT_ID;
const CLIENT_SEC = process.env.HELLOASSO_CLIENT_SECRET;

function assertEnv() {
  const miss = [];
  if (!ORG_SLUG)   miss.push('HELLOASSO_ORG_SLUG');
  if (!CLIENT_ID)  miss.push('HELLOASSO_CLIENT_ID');
  if (!CLIENT_SEC) miss.push('HELLOASSO_CLIENT_SECRET');
  if (miss.length) throw new Error('HelloAsso env manquant: ' + miss.join(', '));
}

async function getAccessToken() {
  assertEnv();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SEC,
  });
  const r = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HelloAsso oauth ${r.status} ${JSON.stringify(j)}`);
  return j.access_token;
}

export async function createCheckoutIntent({ orderId, order, itemName, returnUrl, backUrl, errorUrl }) {
  const token = await getAccessToken();
  const title = String(itemName || `Commande ${orderId || order?._id || ''}`);
  const totalCents = Number(order?.totalCents || 0);

  const payload = {
    totalAmount: totalCents,
    initialAmount: totalCents,
    containsDonation: false,
    itemName: title,
    payer: {
      firstName: order?.payerFirstName || '',
      lastName:  order?.payerLastName  || '',
      email:     order?.payerEmail     || ''
    },
    items: Array.isArray(order?.lines) ? order.lines.map(l => ({
      name: `${l.seatId} • ${l.tariffCode}`,
      amount: Number(l.priceCents || 0),
      quantity: 1
    })) : [],
    returnUrl, backUrl, errorUrl,
    metadata: { orderId: String(orderId || order?._id || '') }
  };

  const url = `${API_V5}/organizations/${encodeURIComponent(ORG_SLUG)}/checkout-intents`;
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
  return { redirectUrl: j.redirectUrl || j.redirectUri || j.url || '' };
}


// Normalise l’extraction d’un éventuel orderId coté HelloAsso
function extractProviderOrderIdFromIntent(j) {
  // couvrez plusieurs formes possibles
  return (
    j?.orderId ||
    j?.order?.id ||
    j?.payment?.orderId ||
    j?.cart?.orderId ||
    null
  );
}


// Tente d'abord /v5/checkout-intents/{id}, puis la route scoppée org si 404/403
export async function getCheckoutIntent(intentId) {
  const token = await getAccessToken();
  const headers = { 'Authorization': `Bearer ${token}` };

  // 1) global
  let r = await fetch(`${API_V5}/checkout-intents/${encodeURIComponent(intentId)}`, { headers });
  if (r.status === 404 || r.status === 403) {
    // 2) scoped
    r = await fetch(`${API_V5}/organizations/${encodeURIComponent(ORG_SLUG)}/checkout-intents/${encodeURIComponent(intentId)}`, { headers });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HelloAsso get intent ${r.status} ${JSON.stringify(j)}`);

  return {
    status:   j.status || j.state || j.paymentStatus || '',
    metadata: j.metadata || {},
    payer:    j.payer || {},
    providerOrderId: extractProviderOrderIdFromIntent(j),
    raw:      j
  };
}

export async function getCheckoutStatus(intentId) {
  const { status } = await getCheckoutIntent(intentId);
  return status;
}
