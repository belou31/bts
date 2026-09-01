import {
  buildReturnUrls,
  createCheckoutIntent,
  currentPaymentProviderId,
  currentPaymentProviderLabel
} from './payments/index.js';
import { sendMail } from '../loaders/mailer.js';
import { formatCurrency } from '../utils/format.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderPaymentLinkEmailHtml({
  order,
  eventName = '',
  redirectUrl,
  providerLabel = currentPaymentProviderLabel()
}) {
  const payerName = [order?.payerFirstName, order?.payerLastName].filter(Boolean).join(' ').trim();
  const resolvedEventName =
    eventName ||
    order?.meta?.eventName ||
    order?.meta?.eventSlug ||
    order?.itemName ||
    'votre evenement';
  const amount = formatCurrency(order?.totalCents || 0, order?.locale);
  const orderId = String(order?._id || '');

  const safeName = escapeHtml(payerName || '');
  const safeEvent = escapeHtml(resolvedEventName);
  const safeAmount = escapeHtml(amount);
  const safeOrderId = escapeHtml(orderId);
  const safeProvider = escapeHtml(providerLabel || 'prestataire');
  const safeLink = escapeHtml(redirectUrl || '');

  return `<!doctype html>
<meta charset="utf-8">
<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
  <p>Bonjour${safeName ? ` ${safeName}` : ''},</p>
  <p>Votre commande <strong>${safeOrderId}</strong> pour <strong>${safeEvent}</strong> est en attente de paiement.</p>
  <p>Montant a regler: <strong>${safeAmount}</strong>.</p>
  <p>Pour finaliser votre achat via ${safeProvider}, utilisez ce lien:</p>
  <p><a href="${safeLink}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#1d4ed8;color:#fff;text-decoration:none">Payer ma commande</a></p>
  <p>Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur:</p>
  <p><a href="${safeLink}">${safeLink}</a></p>
  <p style="color:#6b7280;font-size:12px">Si vous avez deja regle cette commande, ignorez ce message.</p>
</div>`;
}

export async function createPaymentLinkForOrder(order, { source = 'payment-link' } = {}) {
  if (!order?._id) {
    throw new Error('createPaymentLinkForOrder requires an order with _id');
  }

  const providerId = currentPaymentProviderId();
  const providerLabel = currentPaymentProviderLabel();
  const urls = buildReturnUrls(order);
  const intent = await createCheckoutIntent({
    order,
    returnUrl: urls.returnUrl,
    backUrl: urls.backUrl,
    errorUrl: urls.errorUrl
  });

  const redirectUrl = intent?.redirectUrl || intent?.url || '';
  if (!redirectUrl) {
    throw new Error('Checkout intent missing redirectUrl');
  }

  const checkoutId = String(
    intent?.id ||
      intent?.checkoutReference ||
      intent?.raw?.id ||
      intent?.raw?.checkout_reference ||
      ''
  ).trim();
  const checkoutReference = String(
    intent?.checkoutReference ||
      intent?.raw?.checkout_reference ||
      checkoutId
  ).trim();
  const providerOrderId =
    intent?.providerOrderId ||
    intent?.raw?.order?.id ||
    intent?.raw?.orderId ||
    intent?.raw?.transaction_code ||
    intent?.raw?.transaction_id ||
    intent?.raw?.id ||
    null;

  const now = new Date();
  const paymentMeta = { ...(order.paymentProviderMeta || {}) };
  paymentMeta.name = providerId;
  paymentMeta.lastPaymentLinkAt = now;
  paymentMeta.lastPaymentLinkUrl = redirectUrl;
  paymentMeta.lastPaymentLinkSource = source;
  if (checkoutId) paymentMeta.checkoutIntentId = checkoutId;
  if (checkoutReference) paymentMeta.checkoutReference = checkoutReference;
  if (providerOrderId) paymentMeta.providerOrderId = providerOrderId;

  const linkHistory = Array.isArray(paymentMeta.paymentLinkHistory)
    ? paymentMeta.paymentLinkHistory.slice(-9)
    : [];
  linkHistory.push({
    at: now,
    source,
    provider: providerId,
    checkoutIntentId: checkoutId || null,
    checkoutReference: checkoutReference || null,
    providerOrderId: providerOrderId || null,
    redirectUrl
  });
  paymentMeta.paymentLinkHistory = linkHistory;

  order.paymentProvider = providerId;
  order.paymentProviderMeta = paymentMeta;
  order.markModified?.('paymentProviderMeta');
  await order.save();

  return {
    redirectUrl,
    checkoutId,
    checkoutReference,
    providerOrderId,
    providerId,
    providerLabel
  };
}

export async function sendPaymentLinkEmail(
  order,
  { redirectUrl, eventName = '', providerLabel = currentPaymentProviderLabel() } = {}
) {
  if (!order?.payerEmail) {
    throw new Error('Order payerEmail is required to send payment link email');
  }
  if (!redirectUrl) {
    throw new Error('redirectUrl is required to send payment link email');
  }

  const subjectBase =
    process.env.EMAIL_SUBJECT_EVENT_PAYMENT_LINK || 'Lien de paiement - Billetterie';
  const subject = eventName ? `${subjectBase} - ${eventName}` : subjectBase;
  const html = renderPaymentLinkEmailHtml({
    order,
    eventName,
    redirectUrl,
    providerLabel
  });

  await sendMail({ to: order.payerEmail, subject, html });
}
