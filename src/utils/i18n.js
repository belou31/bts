// src/utils/i18n.js
//
// Minimal i18n catalog reader for src/locales/{locale}.json. No library —
// the catalog is small (see docs/i18n-glossary.md for the design rationale:
// structural chrome here, per-season/event/partner content stays in the
// existing data/customization merge chain).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, '..', 'locales');

export const DEFAULT_LOCALE = 'fr';

const catalogCache = new Map();

function loadCatalog(locale) {
  if (catalogCache.has(locale)) return catalogCache.get(locale);
  let catalog = {};
  try {
    const raw = fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8');
    catalog = JSON.parse(raw);
  } catch {
    catalog = {};
  }
  catalogCache.set(locale, catalog);
  return catalog;
}

function getByPath(obj, keyPath) {
  return keyPath.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), obj);
}

function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name) => (
    vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : ''
  ));
}

/**
 * Looks up `key` (dot path, e.g. "saleStatus.open") in the given locale's
 * catalog, falling back to DEFAULT_LOCALE if missing there, and finally to
 * the key itself (visible-but-obvious rather than a blank string, so a
 * missing translation is easy to spot instead of silently disappearing).
 * @param {string} key
 * @param {string} [locale]
 * @param {Record<string, string|number>} [vars]
 */
export function t(key, locale = DEFAULT_LOCALE, vars) {
  let value = getByPath(loadCatalog(locale), key);
  if (value === undefined && locale !== DEFAULT_LOCALE) {
    value = getByPath(loadCatalog(DEFAULT_LOCALE), key);
  }
  if (value === undefined) return key;
  return interpolate(String(value), vars);
}

export function getCatalog(locale = DEFAULT_LOCALE) {
  return loadCatalog(locale);
}
