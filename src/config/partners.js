// src/config/partners.js

import fs from 'fs';
import path from 'path';

const DEFAULT_CONFIGS = [
  {
    slug: 'cseairbus',
    name: 'CSE Airbus',
    paymentMode: 'invoice_auto',
    frameAncestors: [],
    allowedOrigins: [],
    venueView: null,
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
    frameAncestors: [],
    allowedOrigins: [],
    venueView: null,
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

export function getPartnerConfig(slug) {
  if (!slug) return null;
  const key = String(slug).trim().toLowerCase();
  const base = PARTNER_CONFIGS.find(cfg => cfg.slug === key);
  if (!base) return null;
  return base;
}

export function listPartnerConfigs() {
  return [...PARTNER_CONFIGS];
}
