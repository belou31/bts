// src/config/partners.js

import fs from 'fs';
import path from 'path';

const normalizeList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(v => String(v || '').trim()).filter(Boolean);
  }
  return String(value)
    .split(/[,\s]+/)
    .map(v => v.trim())
    .filter(Boolean);
};

const DEFAULT_CONFIGS = [
  {
    slug: 'cseairbus',
    name: 'CSE Airbus',
    paymentMode: 'invoice_auto',
    frameAncestors: normalizeList(process.env.PARTNER_CSEAIRBUS_FRAME || ''),
    allowedOrigins: normalizeList(process.env.PARTNER_CSEAIRBUS_ORIGINS || ''),
    reserve: {
      status: process.env.PARTNER_CSEAIRBUS_STATUS || 'paid',
      paymentProvider: 'cseairbus_invoice',
      autoFinalize: true,
      sendTickets: true,
      payButtonLabel: 'Envoyer ma demande',
      successMessage: 'Votre demande a été enregistrée. Vous recevrez vos billets par email.',
      errorMessage: 'Impossible d’enregistrer votre demande pour le moment. Réessayez dans quelques instants.'
    },
    ui: {
      heading: 'Billetterie CSE Airbus',
      lead: 'Sélectionnez vos places, envoyez la demande et recevez les billets.',
      paymentHelp: 'Le CSE Airbus gère la facturation séparément. Les billets sont envoyés automatiquement après validation.'
    }
  },
  {
    slug: 'aisc',
    name: 'AISC',
    paymentMode: 'psp',
    frameAncestors: normalizeList(process.env.PARTNER_AISC_FRAME || 'https://aisc.example.com'),
    allowedOrigins: normalizeList(process.env.PARTNER_AISC_ORIGINS || 'https://aisc.example.com'),
    reserve: null,
    ui: {
      heading: 'Billetterie AISC',
      lead: 'Accédez à la billetterie négociée par AISC.',
      paymentHelp: 'Paiement sécurisé via BTS.'
    }
  }
];

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

const CUSTOM_CONFIGS = loadCustomConfigs();

function mergeConfigs() {
  const map = new Map();
  const all = [...DEFAULT_CONFIGS, ...CUSTOM_CONFIGS];
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

const PARTNER_CONFIGS = mergeConfigs();

function enrichWithEnv(cfg) {
  const prefix = `PARTNER_${cfg.slug?.toUpperCase() || ''}`;
  const envFrame = process.env[`${prefix}_FRAME`] || process.env[`${prefix}_FRAME_ANCESTORS`];
  const envOrigins = process.env[`${prefix}_ORIGINS`] || process.env[`${prefix}_ALLOWED_ORIGINS`];
  return {
    ...cfg,
    frameAncestors: normalizeList(envFrame || cfg.frameAncestors),
    allowedOrigins: normalizeList(envOrigins || cfg.allowedOrigins)
  };
}

export function getPartnerConfig(slug) {
  if (!slug) return null;
  const key = String(slug).trim().toLowerCase();
  const base = PARTNER_CONFIGS.find(cfg => cfg.slug === key);
  if (!base) return null;
  return enrichWithEnv(base);
}

export function listPartnerConfigs() {
  return PARTNER_CONFIGS.map(enrichWithEnv);
}
