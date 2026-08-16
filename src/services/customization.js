import fs from 'fs';
import path from 'path';
import { DEFAULT_LOCALE } from '../utils/i18n.js';

const CUSTOM_BASE = path.resolve(process.cwd(), 'data', 'customization');

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function mergePrefs(...objs) {
  return objs.reduce((acc, obj) => Object.assign(acc, obj || {}), {});
}

// A customization value is either a plain string (legacy/single-locale — used
// as-is regardless of requested locale) or a { fr: "...", en: "..." } object.
// Falls back to DEFAULT_LOCALE, then to whatever locale IS present, so a
// key translated for only some locales never renders blank.
function resolveLocaleValue(value, locale) {
  if (value == null || typeof value !== 'object') return value;
  if (value[locale] !== undefined) return value[locale];
  if (value[DEFAULT_LOCALE] !== undefined) return value[DEFAULT_LOCALE];
  const firstValue = Object.values(value)[0];
  return firstValue !== undefined ? firstValue : value;
}

// Ordered layers, narrowest wins. Single source of truth for the merge order
// so loadCustomization() (request hot path) and loadCustomizationDebug()
// (used by scripts/00-system-management/resolve-custo.js) can't drift apart.
export function customizationLayers({ seasonCode = '', eventSlug = '', partnerSlug = '' } = {}) {
  const layers = [{ label: 'default', path: path.join(CUSTOM_BASE, 'default.json') }];
  if (seasonCode) layers.push({ label: `season:${seasonCode}`, path: path.join(CUSTOM_BASE, 'seasons', `${seasonCode}.json`) });
  if (eventSlug) layers.push({ label: `event:${eventSlug}`, path: path.join(CUSTOM_BASE, 'events', `${eventSlug}.json`) });
  if (partnerSlug) layers.push({ label: `partner:${partnerSlug}`, path: path.join(CUSTOM_BASE, 'partners', `${partnerSlug}.json`) });
  if (partnerSlug && seasonCode) layers.push({ label: `partner:${partnerSlug}/season:${seasonCode}`, path: path.join(CUSTOM_BASE, 'partners', partnerSlug, 'seasons', `${seasonCode}.json`) });
  if (partnerSlug && eventSlug) layers.push({ label: `partner:${partnerSlug}/event:${eventSlug}`, path: path.join(CUSTOM_BASE, 'partners', partnerSlug, 'events', `${eventSlug}.json`) });
  return layers.map(l => ({ ...l, exists: fs.existsSync(l.path), data: readJson(l.path) }));
}

export function loadCustomization({ seasonCode = '', eventSlug = '', partnerSlug = '', locale = DEFAULT_LOCALE } = {}) {
  const layers = customizationLayers({ seasonCode, eventSlug, partnerSlug });
  const merged = mergePrefs(...layers.map(l => l.data));
  const resolved = {};
  for (const [key, value] of Object.entries(merged)) {
    resolved[key] = resolveLocaleValue(value, locale);
  }
  return resolved;
}

// Debug/CLI-only: same merge as loadCustomization(), plus provenance (which
// layer contributed each key's winning value) and both locales at once.
// Not used on the request path — see scripts/00-system-management/resolve-custo.js.
export function loadCustomizationDebug({ seasonCode = '', eventSlug = '', partnerSlug = '' } = {}) {
  const layers = customizationLayers({ seasonCode, eventSlug, partnerSlug });
  const merged = {};
  const provenance = {};
  for (const layer of layers) {
    if (!layer.exists) continue;
    for (const [key, value] of Object.entries(layer.data)) {
      merged[key] = value;
      provenance[key] = layer.label;
    }
  }
  const byLocale = { fr: {}, en: {} };
  for (const [key, value] of Object.entries(merged)) {
    byLocale.fr[key] = resolveLocaleValue(value, 'fr');
    byLocale.en[key] = resolveLocaleValue(value, 'en');
  }
  return { layers, merged, provenance, byLocale };
}

// Shared context extraction: which season/event/partner/locale an Order
// belongs to, for any code that needs to resolve customization at send time
// (theme selection, email subject overrides — see below).
export function resolveCustomizationForOrder(order) {
  return loadCustomization({
    seasonCode: order?.seasonCode || '',
    eventSlug: order?.meta?.eventSlug || '',
    partnerSlug: order?.meta?.partner?.slug || '',
    locale: order?.locale || DEFAULT_LOCALE
  });
}

// The "theme" customization key selects an email/ticket template variant
// (see src/services/mailer.js and src/services/tickets-pdf.js) — resolved
// through the exact same season/event/partner layering as any other
// customization key, so a themed event (Halloween, Christmas...) or a
// partner's own branding is just a customization file setting "theme",
// with no separate mechanism. Plain string only — not locale-dependent.
export function resolveThemeForOrder(order) {
  const theme = resolveCustomizationForOrder(order).theme;
  return typeof theme === 'string' ? theme.trim() : '';
}

// The "logo" customization key names a file under data/assets/ to embed in
// a ticket's logo slot — same layering as theme, so a partner's own badge is
// a customization file setting "logo", with no separate per-kind mechanism.
// Falls back to data/templates/templates.json's per-kind logo (see
// src/services/tickets-pdf.js) when unset. Plain string only.
export function resolveLogoRefForOrder(order) {
  const logo = resolveCustomizationForOrder(order).logo;
  return typeof logo === 'string' ? logo.trim() : '';
}

// data/customization/app.json is a separate, non-layered file (no season/
// event/partner variants — it's app identity, set once via
// scripts/00-system-management/customize-app.js), so it doesn't go through
// loadCustomization()'s layering. organizationName is the club's display
// name, used in email/ticket contexts wherever "clubName" appears.
export function resolveOrganizationName() {
  const name = readJson(path.join(CUSTOM_BASE, 'app.json')).organizationName;
  return (typeof name === 'string' && name.trim()) ? name.trim() : 'Les Bélougas';
}
