// src/utils/subscription.js
// Helpers to flag orders that originate from subscriptions
export function isSubscriptionOrder(order) {
  if (!order) return false;

  const flow = String(order?.origin?.flow || '').toLowerCase();
  const mailKind = String(order?.mailTemplateKind || '').toLowerCase();
  const phase = String(order?.phase || '').toLowerCase();

  if (flow === 'subscription' || mailKind === 'subscription' || phase === 'subscription') {
    return true;
  }

  if (order.parentOrderId) return true;
  if (order.meta?.seasonParentOrderId) return true;
  if (order.paymentProviderMeta?.seasonOrderId) return true;

  return false;
}

