// Single source of truth for which customization keys are actually read by
// the app, so operator tooling (set-*-custo.js, resolve-custo.js) can flag
// typos instead of the current behavior — silently doing nothing.
//
// Verified by grepping every `customization['...']` / `resolveCusto(...)`
// call site in src/routes at the time this was written. Keep in sync if
// those call sites change.
//
// status: 'active' — read by a route today.
//         'unused' — shipped in data/customization/default.json and/or the
//                     data_references templates, but not read by any route
//                     as of this writing. Not flagged as a typo, but not
//                     doing anything either — see `note` if present.
export const CUSTOMIZATION_KEYS = {
  'subscription.title':             { status: 'active', usedIn: 'src/routes/index.js (subscription page)' },
  'subscription.lead':              { status: 'active', usedIn: 'src/routes/index.js (subscription page)' },
  'subscription.help':              { status: 'active', usedIn: 'src/routes/index.js (subscription page)' },
  'subscription.payButton':         { status: 'active', usedIn: 'src/routes/index.js (subscription page)' },
  'event.title':                    { status: 'active', usedIn: 'src/routes/index.js (event page + partner/event page)' },
  'event.lead':                     { status: 'active', usedIn: 'src/routes/index.js (event page + partner/event page)' },
  'event.help':                     { status: 'active', usedIn: 'src/routes/index.js (event page + partner/event page)' },
  'event.payButton':                { status: 'active', usedIn: 'src/routes/index.js (event page + partner/event page)' },

  'theme':                           { status: 'active', usedIn: 'src/services/mailer.js + src/services/tickets-pdf.js (resolveThemeForOrder) — selects an email/ticket template variant, e.g. "halloween" tries <kind>-confirmation.halloween.html before falling back to the base file. Plain string only, not a {fr,en} object.' },
  'logo':                            { status: 'active', usedIn: 'src/services/tickets-pdf.js (resolveLogoRefForOrder) — names a file under data/assets/ (e.g. "assets/partner01-badge.svg") to embed in a ticket\'s logo slot, ahead of the per-kind default in templates.json. Plain string only, not a {fr,en} object.' },

  'renew.emailSubject':              { status: 'active', usedIn: 'src/services/mailer.js (subjectForOrder) — email subject for "renew" kind orders. Loses to EMAIL_SUBJECT_RENEW_CONFIRM env var if set.' },
  'subscription.emailSubject':       { status: 'active', usedIn: 'src/services/mailer.js (subjectForOrder) — email subject for "subscription" kind orders. Loses to EMAIL_SUBJECT_SUBSCRIPTION_CONFIRM env var if set.' },
  'event.emailSubject':              { status: 'active', usedIn: 'src/services/mailer.js (subjectForOrder) — email subject prefix for "event" kind orders (event name is appended). Loses to EMAIL_SUBJECT_EVENT_CONFIRM env var if set.' },
  'public.emailSubject':             { status: 'active', usedIn: 'src/services/mailer.js (subjectForOrder) — email subject for "public" kind orders. No env var override exists for this kind.' },

  'renew.inviteSubject':             { status: 'active', usedIn: 'src/services/automation/tasks/send-renew-invites.js — default email subject for a renewal-campaign run, season-scoped. Loses to the task\'s "subject"/"emailSubject" param if set. Plain string only, not a {fr,en} object (task has no locale concept).' },
  'renew.inviteTemplate':            { status: 'active', usedIn: 'src/services/automation/tasks/send-renew-invites.js — default email template name for a renewal-campaign run, season-scoped. Loses to the task\'s "template"/"templateName" param if set. Plain string only, not a {fr,en} object.' },

  'subscription.emailConfirmation': { status: 'unused' },
  'subscription.ticket':            { status: 'unused' },
  'event.emailConfirmation':        { status: 'unused' },
  'event.ticket':                   { status: 'unused' },
  'event.confirmation.footer':      { status: 'unused' }

  // The former partner.* namespace (partner.title/lead/help/payButton/
  // emailConfirmation/ticket) was removed: it was never actually reached by
  // resolveCusto() in src/routes/index.js, and the intent behind it (partner
  // branding as its own namespace, overriding event/subscription content) is
  // obsolete. Partner branding is done by overriding the event.*/subscription.*
  // keys directly in a partners/<slug>.json file — see data_references/customization/partner.json.
};

export function classifyKey(key) {
  return CUSTOMIZATION_KEYS[key]?.status || 'unknown';
}

// A customization value must be a plain string, or a { fr, en } object of strings.
export function validateValueShape(value) {
  if (typeof value === 'string') return { ok: true };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (!keys.length) return { ok: false, reason: 'empty locale object' };
    const badKeys = keys.filter(k => k !== 'fr' && k !== 'en');
    if (badKeys.length) return { ok: false, reason: `unexpected locale key(s) "${badKeys.join(', ')}" — expected only "fr"/"en"` };
    const nonString = keys.filter(k => typeof value[k] !== 'string');
    if (nonString.length) return { ok: false, reason: `non-string value for locale(s) "${nonString.join(', ')}"` };
    return { ok: true };
  }
  return { ok: false, reason: `expected a string or {fr,en} object, got ${Array.isArray(value) ? 'an array' : typeof value}` };
}
