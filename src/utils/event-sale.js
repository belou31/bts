// src/utils/event-sale.js
// Lifecycle states for Event.sale and Event.activity — see src/models/Event.js.

export const SALE_STATES = ['notopen', 'presale', 'onsale', 'soldout', 'closed'];
export const ACTIVITY_STATES = ['draft', 'active', 'archived'];

export function isEventOnSale(ev) {
  return ev?.sale === 'onsale';
}

// Hard stop: no purchase path should bypass this, including partner presale quotas.
export function isEventSaleLocked(ev) {
  return ev?.sale === 'soldout' || ev?.sale === 'closed';
}
