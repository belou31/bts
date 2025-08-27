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

/**
 * Crée un checkout-intent HelloAsso
 * @param {object} opts
 *  - orderId, order (mongoose doc)
 *  - itemName (string)
 *  - returnUrl, backUrl, errorUrl
 */
export async function createCheckoutIntent(opts) {
  const { orderId, order, itemName, returnUrl, backUrl, errorUrl } = opts || {};
  const token = await getAccessToken();

  const title = String(itemName || `Commande ${orderId || order?._id || ''}`);

  // Montants en CENTIMES (HelloAsso attend des entiers)
  const totalCents = Number(order?.totalCents || 0);

  const payload = {
    // ⚠️ les 3 champs suivants sont obligatoires
    totalAmount: totalCents,
    initialAmount: totalCents,
    containsDonation: false,

    // ⚠️ requis par l'API : nom de l’item global du checkout
    itemName: title,

    payer: {
      firstName: order?.payerFirstName || '',
      lastName:  order?.payerLastName  || '',
      email:     order?.payerEmail     || ''
    },

    // Détail du panier (optionnel mais utile pour la traçabilité)
    items: Array.isArray(order?.lines) ? order.lines.map(l => ({
      name: `${l.seatId} • ${l.tariffCode}`,
      amount: Number(l.priceCents || 0),
      quantity: 1
      // On pourrait ajouter "type" si nécessaire par l’API (Donation/Product/Contribution),
      // mais pour un checkout simple ce n'est pas requis côté sandbox.
    })) : [],

    // URLs de redirection
    returnUrl,
    backUrl,
    errorUrl,

    // Métadonnées pour retrouver la commande côté /ha/return
    metadata: { orderId: String(orderId || order?._id || '') }
  };

  const url = `${API_V5}/organizations/${encodeURIComponent(ORG_SLUG)}/checkout-intents`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(payload)
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Petit log de debug utile en cas d'erreur de validation
    console.error('[helloasso] payload sent:', JSON.stringify(payload));
    throw new Error(`HelloAsso checkout ${r.status} ${JSON.stringify(j)}`);
  }

  // Normalisation du champ de redirection (selon versions)
  return { redirectUrl: j.redirectUrl || j.redirectUri || j.url || '' };
}
