// src/config/partners.js

import fs from 'fs';
import path from 'path';

function loadCustomConfigs() {
  try {
    const file = path.resolve(process.cwd(), 'data', 'customization', 'partners.json');
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[partners] unable to read customization file:', err.message);
    return [];
  }
}

function mergeConfigs(customList) {
  const map = new Map();
  const all = [...customList];
  all.forEach(cfg => {
    if (!cfg?.slug) return;
    const key = String(cfg.slug).trim().toLowerCase();
    const existing = map.get(key) || {};
    map.set(key, {
      ...existing,
      ...cfg,
      slug: key
    });
  });
  return Array.from(map.values());
}

function getMergedConfigs() {
  const custom = loadCustomConfigs();
  return mergeConfigs(custom);
}

export function getPartnerConfig(slug) {
  if (!slug) return null;
  const key = String(slug).trim().toLowerCase();
  const configs = getMergedConfigs();
  const base = configs.find(cfg => cfg.slug === key);
  if (!base) return null;
  return base;
}

/**
 * Mode de paiement d'un partenaire : « psp » (paiement en ligne) par défaut,
 * comme le créent upsert-partner / import-partners. Seule une valeur
 * explicite autre (« invoice_auto »…) bascule en demande facturée.
 */
export function partnerPaymentMode(cfg) {
  const mode = String(cfg?.paymentMode || '').trim();
  return mode || 'psp';
}

export function isInvoicePartner(cfg) {
  return partnerPaymentMode(cfg) !== 'psp';
}

export function listPartnerConfigs() {
  return getMergedConfigs();
}
