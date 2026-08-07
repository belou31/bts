// src/middlewares/locale.js
//
// Detects and persists the visitor's locale for the customer-facing flow.
// Precedence: explicit ?lang= (also re-persists the cookie) > existing
// "lang" cookie > Accept-Language header > DEFAULT_LOCALE.
//
// Sets req.locale, res.locals.lang (the latter is what src/views/order/
// index.ejs already reads via `typeof lang !== 'undefined' ? lang : 'fr'`,
// so every res.render() call picks this up automatically with no route
// changes needed), res.locals.t (a locale-bound translation helper for use
// directly in EJS templates), res.locals.i18nCatalog (the resolved catalog
// for the current locale, for pages that need to hand strings to
// client-side JS via a window.* config object), and res.locals.formatDate /
// res.locals.formatCurrency (locale-bound Intl formatting helpers, so
// templates never need to import src/utils/format.js or thread req.locale
// through themselves).

import { t as translate, getCatalog } from '../utils/i18n.js';
import { formatDate, formatCurrency } from '../utils/format.js';

export const SUPPORTED_LOCALES = ['fr', 'en'];
export const DEFAULT_LOCALE = 'fr';

const COOKIE_NAME = 'lang';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function pickFromAcceptLanguage(header) {
  if (!header) return null;
  const candidates = String(header)
    .split(',')
    .map((part) => part.split(';')[0].trim().toLowerCase());
  for (const candidate of candidates) {
    const short = candidate.split('-')[0];
    if (SUPPORTED_LOCALES.includes(short)) return short;
  }
  return null;
}

export function localeMiddleware(req, res, next) {
  const queryLang = String(req.query?.lang || '').toLowerCase();
  let locale;

  if (SUPPORTED_LOCALES.includes(queryLang)) {
    locale = queryLang;
    res.cookie(COOKIE_NAME, locale, {
      maxAge: COOKIE_MAX_AGE_MS,
      httpOnly: true,
      sameSite: 'lax'
    });
  } else {
    const cookies = parseCookieHeader(req.headers?.cookie);
    const cookieLang = String(cookies[COOKIE_NAME] || '').toLowerCase();
    if (SUPPORTED_LOCALES.includes(cookieLang)) {
      locale = cookieLang;
    } else {
      locale = pickFromAcceptLanguage(req.headers?.['accept-language']) || DEFAULT_LOCALE;
    }
  }

  req.locale = locale;
  res.locals.lang = locale;
  res.locals.t = (key, vars) => translate(key, locale, vars);
  res.locals.i18nCatalog = getCatalog(locale);
  res.locals.formatDate = (date, options) => formatDate(date, locale, options);
  res.locals.formatCurrency = (cents, currency) => formatCurrency(cents, locale, currency);
  next();
}
