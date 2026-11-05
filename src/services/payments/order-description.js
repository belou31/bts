// src/services/payments/order-description.js
//
// Builds the "description"/"item name" sent to the PSP, with the BTS order
// id always appended. Without it, reconciling a PSP transaction (SumUp,
// HelloAsso) back to a BTS order means cross-referencing checkoutIntentId/
// checkoutReference/providerOrderId by hand — this puts the order id
// somewhere visible directly in the PSP's own dashboard.
//
// Format: <existing itemName>_<orderId> — e.g. "EVENT_match-slug_671f2a3b9c1d4e5f6a7b8c9d".
// Same underscore convention the itemName values already use
// (EVENT_<slug>, RENEW_<seasonCode>_<partnerSlug>, ...), just extended.
//
// Known provider limits on the field this feeds:
//   - HelloAsso `itemName`: 250 chars (dev.helloasso.com/docs/api-overview).
//   - Mollie `description`: 255 chars; the API truncates rather than
//     rejecting, but truncates from whichever end IT chooses — relying on
//     that would risk cutting off exactly the order id we just appended.
//   - SumUp `description`: no documented max (developer.sumup.com/api/schemas/Checkout).
// One shared, conservative cap covers all three rather than tracking a
// different number per provider for a field this short in practice.
const MAX_LENGTH = 250;

// A Mongo ObjectId is always exactly 24 hex chars, so this is fixed length —
// '_' + 24 chars = 25.
function orderIdSuffix(order) {
  const id = String(order?._id || '').trim();
  return id ? `_${id}` : '';
}

/**
 * @param {object} order
 * @param {{ fallback?: string, maxLength?: number }} [options]
 */
export function buildOrderDescription(order, { fallback = 'Order', maxLength = MAX_LENGTH } = {}) {
  const base = String(order?.itemName || '').trim() || fallback;
  const suffix = orderIdSuffix(order);
  if (!suffix) return base.slice(0, maxLength);

  const maxBaseLength = Math.max(0, maxLength - suffix.length);
  const truncatedBase = base.length > maxBaseLength ? base.slice(0, maxBaseLength) : base;
  return `${truncatedBase}${suffix}`;
}
