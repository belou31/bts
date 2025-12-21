// src/config/partners.js

import fs from 'fs';
import path from 'path';

const DEFAULT_CONFIGS = [
  {
    slug: 'cseairbus',
    name: 'CSE Airbus',
    paymentMode: 'invoice_auto',
    allowPublicTariffs: false,
    frameAncestors: [],
    allowedOrigins: [],
    venueView: null,
    admin: { user: null, pass: null },
    reserve: {
      status: 'paid',
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
    allowPublicTariffs: false,
    frameAncestors: [],
    allowedOrigins: [],
    venueView: null,
    admin: { user: null, pass: null },
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

function mergeConfigs(customList) {
  const map = new Map();
  const all = [...DEFAULT_CONFIGS, ...customList];
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

export function listPartnerConfigs() {
  return getMergedConfigs();
}
