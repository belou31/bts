// src/services/helloasso.js
// ESM

// --- Config endpoints dynamiques ---
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

// --- Auth ---
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

// --- Helpers échéancier (LOCAL TIME, ta fonction intégrée) ---
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

// --- API v5: create intent ---
export async function createCheckoutIntent({ order, returnUrl, backUrl, errorUrl }) {
  const token = await getAccessToken();

  // Nombre d’échéances
  const n = Math.max(1, Number(order.installments || order.paymentSplit || 1));

  // Montant total
  const total = Number(order.totalCents || 0);
  if (!total || total < 0) throw new Error('totalAmount invalid');

  // Intitulé
  const itemName =
    order.itemName ||
    `Abonnement ${order.seasonCode || ''}`.trim();

console.log("C08:" + itemName);

  // Répartition des montants (reste sur l’acompte)
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  const initialAmount = base + remainder;

  // Échéances futures (local time) avec clamp du jour
  let terms = [];
  if (n > 1) {
    const start = new Date(); // aujourd’hui (local)
    for (let i = 1; i < n; i++) {
      const due = getOffsetDate(start, i); // +i mois, clamp DOM
      terms.push({ amount: base, date: ymdLocal(due) });
    }
    // Garde-fou : min 10€ (1000 cts) par échéance, sinon on repasse en 1x
    if (terms.some(t => t.amount < 1000)) {
      terms = [];
    }
  }
console.log("C09");

  // Payload conforme
  const payload = {
    totalAmount: total,
    initialAmount,
    containsDonation: false,
    itemName,
    payer: {
      firstName: order.payerFirstName || '',
      lastName:  order.payerLastName  || '',
      email:     order.payerEmail     || ''
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

    returnUrl: returnUrl || process.env.HELLOASSO_RETURN_URL,
    backUrl:   backUrl   || process.env.HELLOASSO_BACK_URL   || `${process.env.APP_URL}/ha/back`,
    errorUrl:  errorUrl  || process.env.HELLOASSO_ERROR_URL  || `${process.env.APP_URL}/ha/error`,
    // métadonnées pour le rapprochement webhook/return
    metadata: {
      orderNo: String(order.orderNo || order._id || ''),
      orderId: String(order._id || '')
    }
  };
  if (terms.length) payload.terms = terms;

  if ((process.env.HELLOASSO_ENV || '').includes('sandbox')) {
    console.log('[helloasso] payload', JSON.stringify(payload));
  }
console.log("C10");
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
  // On renvoie au moins redirectUrl/Uri si dispo
  return {
    redirectUrl: j.redirectUrl || j.redirectUri || j.url || '',
    raw: j
  };
}

// --- API v5: read intent/status ---
function extractProviderOrderIdFromIntent(j) {
  return (
    j?.orderId ||
    j?.order?.id ||
    j?.payment?.orderId ||
    j?.cart?.orderId ||
    null
  );
}

export async function getCheckoutIntent(intentId) {
  const token = await getAccessToken();
  const headers = { 'Authorization': `Bearer ${token}` };

  // global
  let r = await fetch(`${API_V5}/checkout-intents/${encodeURIComponent(intentId)}`, { headers });
  if (r.status === 404 || r.status === 403) {
    // scoped org
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
