// src/utils/format.js
//
// Locale-aware date/currency formatting, replacing hardcoded 'fr-FR' calls
// across the customer-facing flow. Maps our two-letter locale codes to a
// region-qualified BCP-47 tag; 'en' -> 'en-GB' (not 'en-US') so date order
// (DD/MM) stays consistent with 'fr-FR' rather than flipping to MM/DD for a
// currency (EUR) and audience that's still fundamentally European.

const LOCALE_TAGS = { fr: 'fr-FR', en: 'en-GB' };
const DEFAULT_LOCALE = 'fr';

export function resolveLocaleTag(locale) {
  return LOCALE_TAGS[locale] || LOCALE_TAGS[DEFAULT_LOCALE];
}

export function formatCurrency(cents, locale, currency = 'EUR') {
  const amount = Number(cents || 0) / 100;
  return amount.toLocaleString(resolveLocaleTag(locale), { style: 'currency', currency });
}

export function formatCurrencyPlain(cents, locale) {
  const amount = Number(cents || 0) / 100;
  return amount.toLocaleString(resolveLocaleTag(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDate(dateLike, locale, options = { dateStyle: 'long', timeStyle: 'short' }) {
  try {
    const dt = (dateLike instanceof Date) ? dateLike : new Date(dateLike);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleString(resolveLocaleTag(locale), options);
  } catch {
    return '';
  }
}
