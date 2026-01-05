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

export function listPartnerConfigs() {
  return getMergedConfigs();
}
