// static/js/i18n.js — client-side lookup for window.BTS_I18N.catalog
// (injected server-side by src/views/order/index.ejs from the same
// src/locales/{lang}.json catalog src/utils/i18n.js reads on the server),
// plus locale-aware date/currency formatting mirroring src/utils/format.js.
// Loaded before generic-view.js/order.js/event.js/subscription.js so
// window.t()/window.formatDate()/window.formatCurrency() are available.
(() => {
  const I18N = window.BTS_I18N || { lang: 'fr', catalog: {} };
  const LOCALE_TAGS = { fr: 'fr-FR', en: 'en-GB' };
  const localeTag = LOCALE_TAGS[I18N.lang] || LOCALE_TAGS.fr;

  function getByPath(obj, keyPath) {
    return keyPath.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), obj);
  }

  function interpolate(str, vars) {
    if (!vars) return str;
    return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name) => (
      vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : ''
    ));
  }

  window.t = function t(key, vars) {
    const value = getByPath(I18N.catalog, key);
    if (value === undefined) return key;
    return interpolate(String(value), vars);
  };

  window.formatDate = function formatDate(dateLike, options) {
    try {
      const dt = (dateLike instanceof Date) ? dateLike : new Date(dateLike);
      if (Number.isNaN(dt.getTime())) return '';
      return dt.toLocaleString(localeTag, options || { dateStyle: 'long', timeStyle: 'short' });
    } catch {
      return '';
    }
  };

  window.formatCurrency = function formatCurrency(cents, currency) {
    const amount = Number(cents || 0) / 100;
    return amount.toLocaleString(localeTag, { style: 'currency', currency: currency || 'EUR' });
  };
})();
