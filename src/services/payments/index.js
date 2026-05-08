// src/services/payments/index.js
import helloassoProvider from './helloasso.js';
import sumupProvider from './sumup.js';

const providers = {
  helloasso: helloassoProvider,
  sumup: sumupProvider
};

export const paymentProviders = providers;

let cachedProvider = null;
let cachedKey = null;

function pickProvider() {
  if (cachedProvider) return cachedProvider;
  const key = String(process.env.PAYMENT_PROVIDER || 'helloasso').trim().toLowerCase() || 'helloasso';
  const provider = providers[key];
  if (!provider) {
    const available = Object.keys(providers).join(', ') || 'none';
    throw new Error(`Unsupported PAYMENT_PROVIDER "${key}". Available: ${available}`);
  }
  cachedProvider = provider;
  cachedKey = key;
  return cachedProvider;
}

export function currentPaymentProvider() {
  return pickProvider();
}

export function currentPaymentProviderId() {
  return cachedKey || String(currentPaymentProvider().id || 'unknown');
}

export function currentPaymentProviderLabel() {
  if (process.env.PAYMENT_PROVIDER_NAME) {
    const name = String(process.env.PAYMENT_PROVIDER_NAME).trim();
    if (name) return name;
  }
  const provider = currentPaymentProvider();
  return provider.label || provider.id || 'payment-provider';
}

export function buildReturnUrls(order, overrides = {}) {
  const provider = currentPaymentProvider();
  if (typeof provider.buildReturnUrls === 'function') {
    return provider.buildReturnUrls(order, overrides);
  }
  return { ...overrides };
}

export async function createCheckoutIntent(options) {
  const provider = currentPaymentProvider();
  if (typeof provider.createCheckoutIntent !== 'function') {
    throw new Error(`Payment provider "${currentPaymentProviderId()}" does not support checkout intents`);
  }
  return provider.createCheckoutIntent(options);
}

export async function getCheckoutStatus(intentId) {
  const provider = currentPaymentProvider();
  if (typeof provider.getCheckoutStatus !== 'function') {
    throw new Error(`Payment provider "${currentPaymentProviderId()}" does not expose getCheckoutStatus`);
  }
  return provider.getCheckoutStatus(intentId);
}

export async function getCheckoutIntent(intentId) {
  const provider = currentPaymentProvider();
  if (typeof provider.getCheckoutIntent !== 'function') {
    throw new Error(`Payment provider "${currentPaymentProviderId()}" does not expose getCheckoutIntent`);
  }
  return provider.getCheckoutIntent(intentId);
}

export function normalizeStatus(input, fallback) {
  const provider = currentPaymentProvider();
  if (typeof provider.normalizeStatus === 'function') {
    return provider.normalizeStatus(input, fallback);
  }
  const raw = String(input || fallback || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'success' || raw === 'succeeded' || raw === 'ok') return 'succeeded';
  if (raw === 'paid' || raw === 'processed') return 'paid';
  if (raw === 'failure' || raw === 'failed' || raw === 'canceled') return 'failed';
  if (raw === 'refunded' || raw === 'refund') return 'refunded';
  return raw;
}

export function resetPaymentProviderCache() {
  cachedProvider = null;
  cachedKey = null;
}
