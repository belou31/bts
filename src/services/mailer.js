// src/services/mailer.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Tariff } from '../models/Tariff.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const EMAIL_DIR = path.resolve(process.cwd(), 'src', 'templates', 'email');

function fmtEuroWithSymbol(cents) {
  return (Number(cents || 0) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}
function fmtEuroPlain(cents) {
  // Nombre formaté FR sans symbole (ex: "110,60")
  return (Number(cents || 0) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function humanInstallments(n) {
  n = Number(n || 1);
  if (n <= 1) return 'Règlement en une fois.';
  return `Règlement en ${n} échéances.`;
}

function resolveOrderKind(order) {
  if (order.mailTemplateKind) return String(order.mailTemplateKind).toLowerCase();
  if (order.origin?.flow)     return String(order.origin.flow).toLowerCase();
  const phase = String(order.phase || '').toLowerCase();
  if (['renew','fanclub','public','tbh7','grandpublic'].includes(phase)) {
    return phase === 'tbh7' ? 'tbh7'
         : phase === 'grandpublic' ? 'public'
         : phase;
  }
  return 'renew'; // défaut doux
}

const TEMPLATE_BY_KIND = {
  renew:  'renew-confirmation',
  tbh7:   'tbh7-confirmation',     // fan club TBH7
  fanclub:'tbh7-confirmation',     // alias
  public: 'public-confirmation',   // si vous le créez plus tard
};

const SUBJECT_BY_KIND = {
  renew:  process.env.EMAIL_SUBJECT_RENEW_CONFIRM  || 'Confirmation de paiement – Abonnement (Renouvellement)',
  tbh7:   process.env.EMAIL_SUBJECT_TBH7_CONFIRM   || 'Confirmation d’inscription – TBH7',
  fanclub:process.env.EMAIL_SUBJECT_TBH7_CONFIRM   || 'Confirmation d’inscription – TBH7',
  public: process.env.EMAIL_SUBJECT_PUBLIC_CONFIRM || 'Confirmation de paiement – Abonnement (Grand public)',
};

async function loadTemplateHtml(name) {
  const fname = `${name}.html`;
  const p = path.join(EMAIL_DIR, fname);
  return fs.readFile(p, 'utf8');
}

async function buildTariffsMap(seasonCode, venueSlug) {
  try {
    const tar = await Tariff.find({ seasonCode, venueSlug, isActive: true }).lean();
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

// ultra simple “mustache-like” replacer supporting dotted paths (e.g. payer.fullName)
function applyVars(html, ctx) {
  return html.replace(/\{\{\s*([.\w]+)\s*\}\}/g, (_m, key) => {
    const parts = key.split('.');
    let v = ctx;
    for (const p of parts) v = (v && typeof v === 'object') ? v[p] : undefined;
    return (v === undefined || v === null) ? '' : String(v);
  });
}

function lineSeatOrZone(l) {
  // Renew: seatId; TBH7/Public: zoneKey fallback
  return l.seatId || l.zoneKey || '';
}

function formatDateFR(d) {
  try {
    const dt = (d instanceof Date) ? d : new Date(d);
    return dt.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  } catch {
    return '';
  }
}

/**
 * Subject builder (keeps env overrides).
 */
export function subjectForOrder(order) {
  const kind = resolveOrderKind(order);
  return SUBJECT_BY_KIND[kind] || SUBJECT_BY_KIND.renew;
}

/**
 * Render email HTML for an Order, using the right template and context.
 * Works with your two current templates:
 *  - renew-confirmation.html (expects {{linesRows}}, {{installmentsInfo}}, etc.)
 *  - tbh7-confirmation.html  (expects {{LINES_HTML}} and nested objects)
 */
export async function renderOrderEmail(order) {
  const kind = resolveOrderKind(order);
  const tplName = TEMPLATE_BY_KIND[kind] || TEMPLATE_BY_KIND.renew;

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
    ? `<p>Référence HelloAsso : <b>${haOrderId}</b></p>`
    : '';

  // Build rows (two variants)
  const renewRows = (Array.isArray(order.lines) ? order.lines : [])
    .map(l => {
      const place = lineSeatOrZone(l);
      const tarif = getTariffLabel(l.tariffCode, tariffsMap);
      const price = fmtEuroPlain(l.priceCents);
      return `<tr><td>${place}</td><td>${tarif}</td><td>${price} €</td></tr>`;
    })
    .join('');

  const tbh7Rows = (Array.isArray(order.lines) ? order.lines : [])
    .map(l => {
      const place = lineSeatOrZone(l);
      const beneficiaire = [l.holderFirstName, l.holderLastName].filter(Boolean).join(' ').trim();
      const tarif = getTariffLabel(l.tariffCode, tariffsMap);
      const price = fmtEuroWithSymbol(l.priceCents);
      return `<tr><td>${place}</td><td>${beneficiaire}</td><td>${tarif}</td><td>${price}</td></tr>`;
    })
    .join('');

  const htmlRaw = await loadTemplateHtml(tplName);

  if (tplName === 'tbh7-confirmation') {
    const ctx = {
      org: { clubName: (process.env.CLUB_NAME || 'Les Bélougas') },
      payer: {
        fullName: [order.payerFirstName, order.payerLastName].filter(Boolean).join(' ').trim()
      },
      order: {
        id: String(order._id),
        seasonCode: order.seasonCode || '',
        venueSlug: order.venueSlug || '',
        totalEuro: fmtEuroWithSymbol(totalCents),
        split,
        installmentsHuman: humanInstallments(split),
        createdAt: formatDateFR(order.createdAt)
      },
      LINES_HTML: tbh7Rows
    };
    return applyVars(htmlRaw, ctx);
  }

  // default: renew-confirmation.html (your current Renew template)
  const ctx = {
    payerFirstName: order.payerFirstName || '',
    payerLastName:  order.payerLastName  || '',
    payerEmail:     order.payerEmail     || '',
    orderId:        String(order._id),
    seasonCode:     order.seasonCode || '',
    venueSlug:      order.venueSlug || '',

    totalEuro:      fmtEuroPlain(totalCents),       // template ajoute " €"
    installmentsInfo: humanInstallments(split),

    haOrderBlock,
    clubName: (process.env.CLUB_NAME || 'Les Bélougas'),
    linesRows: renewRows,
    extraInfo: '', // slot libre si besoin
  };

  return applyVars(htmlRaw, ctx);
}
