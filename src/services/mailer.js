// src/services/mailer.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Tariff } from '../models/Tariff.js';
import { hexToQrSvg } from './qr.js';
import { currentPaymentProviderLabel } from './payments/index.js';
import { buildTicketsPdfBuffer as buildTicketsPdfBufferFromService } from './tickets-pdf.js';
import { resolveLinePlacement } from '../utils/event-attendance.js';
import { isZoneUnit } from '../utils/seat-id.js';
import { formatCurrency, formatCurrencyPlain, formatDate } from '../utils/format.js';
import { t, getCatalog, DEFAULT_LOCALE } from '../utils/i18n.js';
import { resolveThemeForOrder, resolveCustomizationForOrder, resolveOrganizationName } from './customization.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const EMAIL_ROOT_RUNTIME = path.resolve(process.cwd(), 'data', 'templates');
const EMAIL_CONFIG_CUSTOM     = path.resolve(process.cwd(), 'data', 'templates', 'templates.json');
const EMAIL_DIR_RUNTIME = path.join(EMAIL_ROOT_RUNTIME, 'email'); // user-provided HTML files

function fmtEuroWithSymbol(cents, locale) {
  return formatCurrency(cents, locale);
}
function fmtEuroPlain(cents, locale) {
  // Nombre formaté sans symbole (ex: "110,60" en fr, "110.60" en en)
  return formatCurrencyPlain(cents, locale);
}
function humanInstallments(n, locale) {
  n = Number(n || 1);
  if (n <= 1) return t('email.paymentOnce', locale);
  return t('email.paymentInstallments', locale, { n });
}

function resolveOrderKind(order) {
  const normalize = (val) => {
    const k = String(val || '').toLowerCase();
    if (k === 'fanclub') return 'subscription';
    return k;
  };

  // ➤ Priorité: une commande “match” porte meta.eventId → kind = 'event'
  if (order?.meta?.eventId) return 'event';
  // Compat existant : champs optionnels
  if (order.mailTemplateKind) return normalize(order.mailTemplateKind);
  if (order.origin?.flow)     return normalize(order.origin.flow);
  const phase = normalize(order.phase);
  if (['renew','subscription','event','public'].includes(phase)) return phase;
  return 'renew';
}


// Subject env overrides are kept separate from DEFAULT_TEMPLATE_CONFIG (unlike
// before) so the code-default subject can be resolved per-locale at request
// time instead of being frozen into a single language at module load.
const EMAIL_SUBJECT_ENV = {
  renew: process.env.EMAIL_SUBJECT_RENEW_CONFIRM || null,
  subscription: process.env.EMAIL_SUBJECT_SUBSCRIPTION_CONFIRM || null,
  event: process.env.EMAIL_SUBJECT_EVENT_CONFIRM || null
};

// Subject text lives in data/customization (default.json baseline, overridable
// per season/event/partner) rather than data/templates/templates.json — it's
// genuine translatable content, not file routing, so it belongs with every
// other piece of copy and gets the same layering (e.g. an event-specific or
// partner-specific subject line, which templates.json could never express).
const SUBJECT_CUSTOMIZATION_KEY_BY_KIND = {
  renew: 'renew.emailSubject',
  subscription: 'subscription.emailSubject',
  event: 'event.emailSubject',
  public: 'public.emailSubject'
};

function customSubjectForOrder(order, kind) {
  const key = SUBJECT_CUSTOMIZATION_KEY_BY_KIND[kind];
  if (!key) return null;
  const value = resolveCustomizationForOrder(order)[key];
  return (typeof value === 'string' && value.trim()) ? value.trim() : null;
}

const SUBJECT_KEY_BY_KIND = {
  renew: 'email.subjectRenew',
  subscription: 'email.subjectSubscription',
  event: 'email.subjectEvent'
};

// Last-resort fallback if default.json's own customization key is ever
// missing (e.g. a corrupted/fresh install) — normally unreachable, since
// SUBJECT_CUSTOMIZATION_KEY_BY_KIND's default.json values always exist.
function defaultSubjectForKind(kind, locale) {
  return t(SUBJECT_KEY_BY_KIND[kind] || SUBJECT_KEY_BY_KIND.renew, locale);
}

const DEFAULT_TEMPLATE_CONFIG = {
  renew: { file: 'renew-confirmation.html' },
  subscription: { file: 'subscription-confirmation.html' },
  event: { file: 'event-confirmation.html' }
};

let EMAIL_CONFIG_PROMISE = null;
let EMAIL_TEMPLATE_CACHE = { ...DEFAULT_TEMPLATE_CONFIG };
async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function getEmailConfig() {
  if (EMAIL_CONFIG_PROMISE) return EMAIL_CONFIG_PROMISE;
  EMAIL_CONFIG_PROMISE = (async () => {
    const base = (await readJsonIfExists(EMAIL_CONFIG_CUSTOM)) || {};
    const section =
      (base.email && base.email.templates)
      || (base.templates && base.templates.email)
      || base.templates
      || base.email
      || {};
    const merged = { ...DEFAULT_TEMPLATE_CONFIG };
    if (section && typeof section === 'object') {
      for (const [kind, entry] of Object.entries(section)) {
        if (!entry || typeof entry !== 'object') continue;
        const file = entry.file || entry.template || entry.name;
        if (!file) continue;
        merged[kind] = { file }; // subject: see SUBJECT_CUSTOMIZATION_KEY_BY_KIND above
      }
    }
    EMAIL_TEMPLATE_CACHE = merged;
    return merged;
  })();
  return EMAIL_CONFIG_PROMISE;
}

// theme (optional): tries "<name>.<theme>.html" first, falls back to the
// plain "<name>.html" if that themed variant doesn't exist yet — see
// resolveThemeForOrder() in ./customization.js.
async function loadTemplateHtml(nameOrPath, theme) {
  const fname = nameOrPath.endsWith('.html') ? nameOrPath : `${nameOrPath}.html`;
  const candidates = [];
  if (theme) {
    const themedName = `${fname.slice(0, -'.html'.length)}.${theme}.html`;
    candidates.push(path.join(EMAIL_DIR_RUNTIME, themedName), path.resolve(EMAIL_ROOT_RUNTIME, themedName));
  }
  candidates.push(path.join(EMAIL_DIR_RUNTIME, fname), path.resolve(EMAIL_ROOT_RUNTIME, fname));
  for (const p of candidates) {
    try {
      return await fs.readFile(p, 'utf8');
    } catch (err) {
      // continue
    }
  }
  throw new Error(`Email template not found: ${nameOrPath} (searched in data/templates)`);
}

async function buildTariffsMap(seasonCode, venueSlug) {
  try {
    const tar = await Tariff.find({ seasonCode, venueSlug, active: true }).lean();
    const map = new Map();
    for (const t of tar) map.set(String(t.code || '').toUpperCase(), t.label || t.code);
    return map;
  } catch {
    return new Map();
  }
}

function getTariffLabel(code, map) {
  const up = String(code || '').toUpperCase();
  return map.get(up) || up || '';
}

// ——— Normalisation d'une ligne, utilisée pour un rendu unique (4 colonnes)
function normalizeLine(l, tariffsMap, locale) {
  const seat = lineSeatOrZone(l);
  const beneficiary = [l.holderFirstName, l.holderLastName].filter(Boolean).join(' ').trim();
  const tariff = getTariffLabel(l.tariffCode, tariffsMap);
  const priceCents = Number(l.priceCents)||0;
  return {
    seat, beneficiary, tariff,
    pricePlain: fmtEuroPlain(priceCents, locale), priceRich: fmtEuroWithSymbol(priceCents, locale)
  };
}


// ultra simple “mustache-like” replacer supporting dotted paths (e.g. payer.fullName).
// Runs a few passes so a substituted value that itself contains {{...}}
// tokens — e.g. a t.email.* catalog string like "...saison {{seasonCode}}..."
// — gets those resolved too, not left as literal text. Bounded at 3 passes
// and stops early once stable, so this can't loop on a pathological value.
function applyVars(html, ctx) {
  let result = html;
  for (let i = 0; i < 3; i++) {
    const before = result;
    result = result.replace(/\{\{\s*([.\w]+)\s*\}\}/g, (_m, key) => {
      const parts = key.split('.');
      let v = ctx;
      for (const p of parts) v = (v && typeof v === 'object') ? v[p] : undefined;
      return (v === undefined || v === null) ? '' : String(v);
    });
    if (result === before) break;
  }
  return result;
}

function lineSeatOrZone(l) {
  // Ligne "zone" (standing/GA) : on affiche la zone plutôt que le seatId
  // (réel ou synthétique — voir src/utils/seat-id.js).
  //
  // Le siège annoncé doit être celui où la personne s'assied POUR CE MATCH :
  // un changement de place est un override et laisse l.seatId sur l'ancienne
  // (utils/event-attendance.js). Sans cette résolution, le corps du mail
  // contredirait le PDF joint et le contrôle d'accès.
  const placement = resolveLinePlacement(l);
  const sid = String((placement.moved && placement.seatId) || l.seatId || '');
  if (sid && isZoneUnit({ unitType: l.unitType, seatId: sid })) return String(l.zoneKey||'');
  return sid || String(l.zoneKey||'');
}

function formatDateFR(d, locale) {
  return formatDate(d, locale, { dateStyle: 'long', timeStyle: 'short' });
}

// -- Helpers "tickets / QR" ---------------------------------------------------
function shortHex(h) {
  const s = String(h||'');
  return s.length > 12 ? (s.slice(0,6) + '…' + s.slice(-4)) : s;
}

async function buildTicketsHtml(order) {
  const locale = order?.locale || DEFAULT_LOCALE;
  // tickets attendus en: order.meta.tickets = [{ seatId, tariff, hex }, ...]
  const ticketsRaw = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  const tickets = ticketsRaw.filter(tk => tk && tk.hex);
  if (!tickets.length) {
    throw new Error('No QR codes available for tickets');
  }

  // Génère les SVG en parallèle
  const svgs = await Promise.all(
    tickets.map(tk => hexToQrSvg(tk.hex, { ecl:'M', margin:1 }))
  );

  const rows = tickets.map((tk, i) => {
    const seat = tk.seatId || tk.zoneKey || '';
    const tarif = String(tk.tariff||'').toUpperCase();
    const hex = tk.hex || '';
    const svg = svgs[i] || '';
    return `
      <tr>
        <td style="padding:8px 6px;vertical-align:top">${seat}</td>
        <td style="padding:8px 6px;vertical-align:top">${tarif}</td>
        <td style="padding:8px 6px;vertical-align:top"><code>${shortHex(hex)}</code></td>
        <td style="padding:8px 6px;vertical-align:top">
          <div class="qr" style="width:120px;height:auto">${svg}</div>
        </td>
      </tr>`;
  }).join('');

  return `
    <div class="tickets" style="margin-top:24px">
      <h2 style="margin:0 0 12px">${t('email.tickets', locale)}</h2>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th align="left" style="text-align:left;padding:6px 6px;border-bottom:1px solid #e5e7eb">${t('common.seat', locale)}</th>
            <th align="left" style="text-align:left;padding:6px 6px;border-bottom:1px solid #e5e7eb">${t('common.tariff', locale)}</th>
            <th align="left" style="text-align:left;padding:6px 6px;border-bottom:1px solid #e5e7eb">${t('common.code', locale)}</th>
            <th align="left" style="text-align:left;padding:6px 6px;border-bottom:1px solid #e5e7eb">${t('email.qrColumn', locale)}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:8px;color:#6b7280;font-size:12px">${t('email.keepQrNote', locale)}</p>
    </div>`;
}

function injectTicketsHtml(html, ticketsHtml) {
  if (!ticketsHtml) return html;
  if (html.includes('{{TICKETS_HTML}}')) {
    return html.replace('{{TICKETS_HTML}}', ticketsHtml);
  }
  // fallback: insertion avant </body> si présent, sinon concat
  const idx = html.lastIndexOf('</body>');
  if (idx !== -1) {
    return html.slice(0, idx) + ticketsHtml + html.slice(idx);
  }
  return html + ticketsHtml;
}


/**
 * Subject builder. Precedence: env var (ops override) > customization key
 * (season/event/partner-scoped, see SUBJECT_CUSTOMIZATION_KEY_BY_KIND) >
 * i18n code default (last-resort fallback).
 */
export async function subjectForOrder(order) {
  await getEmailConfig().catch(() => {}); // best effort to hydrate cache
  const kind = resolveOrderKind(order);
  const locale = order?.locale || DEFAULT_LOCALE;
  const customSubject = customSubjectForOrder(order, kind);
  if (kind === 'event') {
    const ename = order?.meta?.eventName || order?.meta?.eventSlug || t('common.match', locale);
    const base  = EMAIL_SUBJECT_ENV.event || customSubject || defaultSubjectForKind('event', locale);
    return `${base} — ${ename}`;
  }

  return EMAIL_SUBJECT_ENV[kind] || customSubject || defaultSubjectForKind(kind, locale);
}

/**
  * Render email HTML for an Order, using the right template and context.
  * Works with your two current templates:
  *  - renew-confirmation.html (expects {{linesRows}}, {{installmentsInfo}}, etc.)
 *  - fanclub-confirmation.html / subscription-confirmation.html
  *    (expect {{LINES_HTML}} and nested objects)
  */

export async function renderOrderEmail(order) {
  const kind = resolveOrderKind(order);
  const config = await getEmailConfig();
  const tplName = config[kind]?.file || config.renew.file;
  const theme = resolveThemeForOrder(order);
  const includeTicketsInline = kind !== 'event';
  const locale = order.locale || 'fr';

  const tariffsMap = await buildTariffsMap(order.seasonCode, order.venueSlug);

  // Common derived fields
  const totalCents = Number(order.totalCents || 0);
  const split = Number(order.paymentSplit || order.installments || 1);

  const haOrderId =
    order.paymentProviderMeta?.haOrderId ||
    order.paymentProviderOrderId ||
    order.meta?.haOrderId ||
    null;

  const haOrderBlock = haOrderId
    ? `<p>${t('email.paymentReference', locale, { provider: currentPaymentProviderLabel() })} <b>${haOrderId}</b></p>`
    : '';

  // Rendu unique (4 colonnes) → LINES_HTML
  const _lines = Array.isArray(order.lines) ? order.lines : [];
  const normalized = _lines.map(l => normalizeLine(l, tariffsMap, locale));
  const LINES_HTML = normalized.map(c =>
    `<tr><td>${c.seat}</td><td>${c.beneficiary}</td><td>${c.tariff}</td><td>${c.priceRich}</td></tr>`
  ).join('');

  const htmlRaw = await loadTemplateHtml(tplName, theme);
  const ticketsHtml = includeTicketsInline ? await buildTicketsHtml(order) : '';

  if (kind === 'event') {
    const ename = order?.meta?.eventName || order?.meta?.eventSlug || t('common.match', locale);
    // Contexte unifié (event)
    const ctx = {
      org: { clubName: resolveOrganizationName() },
      payer: {
        fullName: [order.payerFirstName || order?.payer?.firstName, order.payerLastName || order?.payer?.lastName]
                  .filter(Boolean).join(' ').trim()
      },
      order: {
        id: String(order._id),
        seasonCode: order.seasonCode || '',
        venueSlug: order.venueSlug || '',
        totalEuro: fmtEuroWithSymbol(totalCents, locale),
        split,
        installmentsHuman: humanInstallments(split, locale),
        createdAt: formatDateFR(order.createdAt, locale),
        eventName: ename
      },
      LINES_HTML,
      TICKETS_HTML: '',   // pas de QR inline pour les events (PDF joint)
      t: getCatalog(locale),
      // compat héritée
      payerFirstName: order.payerFirstName || order?.payer?.firstName || '',
      payerLastName:  order.payerLastName  || order?.payer?.lastName  || '',
      payerEmail:     order.payerEmail     || order?.payer?.email     || '',
      orderId:        String(order._id),
      totalEuro:      fmtEuroWithSymbol(totalCents, locale),
      totalEuroPlain: fmtEuroPlain(totalCents, locale),
      installmentsInfo: humanInstallments(split, locale),
      haOrderBlock,
      clubName: resolveOrganizationName(),
      linesRows: LINES_HTML,
      extraInfo: ''
    };
    return applyVars(htmlRaw, ctx); // pas de QR inline pour event (PDF joint)
  }

  // ——— Non-event (renew / subscription / public)
  const ctx = {
    org: { clubName: resolveOrganizationName() },
    payer: {
      fullName: [order.payerFirstName || order?.payer?.firstName, order.payerLastName || order?.payer?.lastName]
                 .filter(Boolean).join(' ').trim()
    },
    order: {
      id: String(order._id),
      seasonCode: order.seasonCode || '',
      venueSlug: order.venueSlug || '',
      totalEuro: fmtEuroWithSymbol(totalCents, locale),
      split,
      installmentsHuman: humanInstallments(split, locale),
      createdAt: formatDateFR(order.createdAt, locale)
    },
    LINES_HTML: LINES_HTML,
    TICKETS_HTML: ticketsHtml,
    t: getCatalog(locale),
    // compat héritée
    payerFirstName: order.payerFirstName || order?.payer?.firstName || '',
    payerLastName:  order.payerLastName  || order?.payer?.lastName  || '',
    payerEmail:     order.payerEmail     || order?.payer?.email     || '',
    orderId:        String(order._id),
    totalEuro:      fmtEuroWithSymbol(totalCents, locale),
    totalEuroPlain: fmtEuroPlain(totalCents, locale),
    installmentsInfo: humanInstallments(split, locale),
    haOrderBlock,
    clubName: resolveOrganizationName(),
    linesRows: LINES_HTML,
    extraInfo: ''
  };
  return injectTicketsHtml(applyVars(htmlRaw, ctx), ticketsHtml);

}

// Génère un PDF (délégué à services/tickets-pdf pour rester aligné avec l’email)
export const buildTicketsPdfBuffer = buildTicketsPdfBufferFromService;




// Attribue des QR depuis la banque associée à l'événement (event only)
export async function attachQrFromBank(db, order){
  const Events = db.collection('events');
  const evId   = String(order?.meta?.eventId||'');
  if (!evId) return { ok:false, reason:'no-event' };
  const { ObjectId } = await import('mongodb');
  const ev = await Events.findOne({ _id: new ObjectId(evId) });
  const flattenBuckets = (buckets) => {
    if (!buckets || typeof buckets !== 'object') return [];
    const acc = [];
    for (const value of Object.values(buckets)) {
      if (!Array.isArray(value)) continue;
      for (const hex of value) {
        if (!hex) continue;
        acc.push(String(hex).trim());
      }
    }
    return acc;
  };

  const bank = ev?.qrBank || null;
  if (!bank) return { ok:false, reason:'no-bank' };

  const lines = Array.isArray(order?.lines) ? order.lines : [];
  const needed = lines.length;

  const availableCodes = Array.isArray(bank.codes) && bank.codes.length > 0
    ? [...bank.codes]
    : flattenBuckets(bank.buckets);

  if (!availableCodes.length) {
    if (needed === 0) return { ok:true, tickets: [] };
    return {
      ok: false,
      reason: 'depleted',
      detail: { needed, available: 0, eventId: evId, eventSlug: ev.slug || null }
    };
  }
  const initialAvailable = availableCodes.length;

  if (initialAvailable < needed) {
    return {
      ok: false,
      reason: 'depleted',
      detail: { needed, available: initialAvailable, eventId: evId, eventSlug: ev.slug || null }
    };
  }

  const tickets = [];
  for (const ln of lines) {
    const hex = availableCodes.shift();
    if (!hex) {
      return {
        ok: false,
        reason: 'depleted',
        detail: { needed, available: initialAvailable - availableCodes.length, eventId: evId, eventSlug: ev.slug || null }
      };
    }
    const tariff = String(ln?.tariffCode || ln?.tariff || 'NORMAL').toUpperCase();
    tickets.push({
      seatId: ln?.seatId || '',
      zoneKey: ln?.zoneKey || '',
      tariff,
      hex
    });
  }

  const update = { $set: { 'qrBank.codes': availableCodes } };
  if (bank.buckets) {
    update.$unset = { 'qrBank.buckets': '' };
  }
  await Events.updateOne({ _id: ev._id }, update);
  return { ok:true, tickets };
}
