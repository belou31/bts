// src/services/mailer.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Tariff } from '../models/Tariff.js';
import { hexToQrSvg } from './qr.js';
import { currentPaymentProviderLabel } from './payments/index.js';
import { buildTicketsPdfBuffer as buildTicketsPdfBufferFromService } from './tickets-pdf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const EMAIL_ROOT_RUNTIME = path.resolve(process.cwd(), 'data', 'templates');
const EMAIL_ROOT_REF     = path.resolve(process.cwd(), 'data_references', 'templates');
const EMAIL_DIR_CUSTOM_CONFIG = path.join(EMAIL_ROOT_RUNTIME, 'email');
const EMAIL_CONFIG_CUSTOM     = path.resolve(process.cwd(), 'data', 'templates', 'templates.json');
const EMAIL_CONFIG_TEMPLATE   = path.resolve(process.cwd(), 'data_references', 'templates', 'templates.json');
const EMAIL_DIR_DATA   = path.join(EMAIL_ROOT_REF, 'email');      // reference
const EMAIL_DIR_RUNTIME = EMAIL_DIR_CUSTOM_CONFIG; // user-provided HTML files

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


const DEFAULT_TEMPLATE_CONFIG = {
  renew: {
    file: 'renew-confirmation.html',
    subject: process.env.EMAIL_SUBJECT_RENEW_CONFIRM || 'Confirmation – Abonnement (Renouvellement)'
  },
  subscription: {
    file: 'subscription-confirmation.html',
    subject: process.env.EMAIL_SUBJECT_SUBSCRIPTION_CONFIRM || 'Confirmation – Abonnement'
  },
  event: {
    file: 'event-confirmation.html',
    subject: process.env.EMAIL_SUBJECT_EVENT_CONFIRM || 'Confirmation – Billetterie'
  }
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
    const custom = await readJsonIfExists(EMAIL_CONFIG_CUSTOM);
    const templ  = await readJsonIfExists(EMAIL_CONFIG_TEMPLATE);
    const base = custom || templ || {};
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
        merged[kind] = {
          file,
          subject: entry.subject || merged[kind]?.subject || null
        };
      }
    }
    EMAIL_TEMPLATE_CACHE = merged;
    return merged;
  })();
  return EMAIL_CONFIG_PROMISE;
}

async function loadTemplateHtml(nameOrPath) {
  const fname = nameOrPath.endsWith('.html') ? nameOrPath : `${nameOrPath}.html`;
  const paths = [
    path.join(EMAIL_DIR_RUNTIME, fname),
    path.join(EMAIL_DIR_DATA, fname),
    path.resolve(EMAIL_ROOT_RUNTIME, fname),
    path.resolve(EMAIL_ROOT_REF, fname)
  ];
  for (const p of paths) {
    try {
      return await fs.readFile(p, 'utf8');
    } catch (err) {
      // continue
    }
  }
  throw new Error(`Email template not found: ${nameOrPath} (searched in data/templates and data_references/templates)`);
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
function normalizeLine(l, tariffsMap) {
  const seat = lineSeatOrZone(l);
  const beneficiary = [l.holderFirstName, l.holderLastName].filter(Boolean).join(' ').trim();
  const tariff = getTariffLabel(l.tariffCode, tariffsMap);
  const priceCents = Number(l.priceCents)||0;
  return {
    seat, beneficiary, tariff,
    pricePlain: fmtEuroPlain(priceCents), priceRich: fmtEuroWithSymbol(priceCents)
  };
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

const VIRT_RE = /^.+-Z\d{3,}$/i;
function lineSeatOrZone(l) {
  // Si ID virtuel (ex: DEBOUT-Z001), on affiche la zone (DEBOUT)
  const sid = String(l.seatId||'');
  if (sid && VIRT_RE.test(sid)) return String(l.zoneKey||'');
  return sid || String(l.zoneKey||'');
}

function formatDateFR(d) {
  try {
    const dt = (d instanceof Date) ? d : new Date(d);
    return dt.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  } catch {
    return '';
  }
}

// -- Helpers "tickets / QR" ---------------------------------------------------
function shortHex(h) {
  const s = String(h||'');
  return s.length > 12 ? (s.slice(0,6) + '…' + s.slice(-4)) : s;
}

async function buildTicketsHtml(order) {
  // tickets attendus en: order.meta.tickets = [{ seatId, tariff, hex }, ...]
  const ticketsRaw = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  const tickets = ticketsRaw.filter(t => t && t.hex);
  if (!tickets.length) {
    throw new Error('No QR codes available for tickets');
  }

  // Génère les SVG en parallèle
  const svgs = await Promise.all(
    tickets.map(t => hexToQrSvg(t.hex, { ecl:'M', margin:1 }))
  );

  const rows = tickets.map((t, i) => {
    const seat = t.seatId || t.zoneKey || '';
    const tarif = String(t.tariff||'').toUpperCase();
    const hex = t.hex || '';
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
      <h2 style="margin:0 0 12px">Billets</h2>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th align="left" style="text-align:left;padding:6px 6px;border-bottom:1px solid #e5e7eb">Place</th>
            <th align="left" style="text-align:left;padding:6px 6px;border-bottom:1px solid #e5e7eb">Tarif</th>
            <th align="left" style="text-align:left;padding:6px 6px;border-bottom:1px solid #e5e7eb">Code</th>
            <th align="left" style="text-align:left;padding:6px 6px;border-bottom:1px solid #e5e7eb">QR</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:8px;color:#6b7280;font-size:12px">Conservez ces QR et présentez-les à l’entrée.</p>
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
 * Subject builder (keeps env overrides).
 */
export async function subjectForOrder(order) {
  await getEmailConfig().catch(() => {}); // best effort to hydrate cache
  const kind = resolveOrderKind(order);
  if (kind === 'event') {
    const ename = order?.meta?.eventName || order?.meta?.eventSlug || 'Match';
    const base  = EMAIL_TEMPLATE_CACHE.event?.subject || DEFAULT_TEMPLATE_CONFIG.event.subject;
    return `${base} — ${ename}`;
  }

  return EMAIL_TEMPLATE_CACHE[kind]?.subject || DEFAULT_TEMPLATE_CONFIG[kind]?.subject || DEFAULT_TEMPLATE_CONFIG.renew.subject;
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
  const includeTicketsInline = kind !== 'event';

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
    ? `<p>Référence ${currentPaymentProviderLabel()} : <b>${haOrderId}</b></p>`
    : '';

  // Rendu unique (4 colonnes) → LINES_HTML
  const _lines = Array.isArray(order.lines) ? order.lines : [];
  const normalized = _lines.map(l => normalizeLine(l, tariffsMap));
  const LINES_HTML = normalized.map(c =>
    `<tr><td>${c.seat}</td><td>${c.beneficiary}</td><td>${c.tariff}</td><td>${c.priceRich}</td></tr>`
  ).join('');

  const htmlRaw = await loadTemplateHtml(tplName);
  const ticketsHtml = includeTicketsInline ? await buildTicketsHtml(order) : '';

  if (kind === 'event') {
    const ename = order?.meta?.eventName || order?.meta?.eventSlug || 'Match';
    // Contexte unifié (event)
    const ctx = {
      org: { clubName: (process.env.CLUB_NAME || 'Les Bélougas') },
      payer: {
        fullName: [order.payerFirstName || order?.payer?.firstName, order.payerLastName || order?.payer?.lastName]
                  .filter(Boolean).join(' ').trim()
      },
      order: {
        id: String(order._id),
        seasonCode: order.seasonCode || '',
        venueSlug: order.venueSlug || '',
        totalEuro: fmtEuroWithSymbol(totalCents),
        split,
        installmentsHuman: humanInstallments(split),
        createdAt: formatDateFR(order.createdAt),
        eventName: ename
      },
      LINES_HTML,
      TICKETS_HTML: '',   // pas de QR inline pour les events (PDF joint)
      // compat héritée
      payerFirstName: order.payerFirstName || order?.payer?.firstName || '',
      payerLastName:  order.payerLastName  || order?.payer?.lastName  || '',
      payerEmail:     order.payerEmail     || order?.payer?.email     || '',
      orderId:        String(order._id),
      totalEuroPlain: fmtEuroPlain(totalCents),
      installmentsInfo: humanInstallments(split),
      haOrderBlock,
      clubName: (process.env.CLUB_NAME || 'Les Bélougas'),
      linesRows: LINES_HTML,
      extraInfo: ''
    };
    return applyVars(htmlRaw, ctx); // pas de QR inline pour event (PDF joint)
  }

  // ——— Non-event (renew / subscription / public)
  const ctx = {
    org: { clubName: (process.env.CLUB_NAME || 'Les Bélougas') },
    payer: {
      fullName: [order.payerFirstName || order?.payer?.firstName, order.payerLastName || order?.payer?.lastName]
                 .filter(Boolean).join(' ').trim()
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
    LINES_HTML: LINES_HTML,
    TICKETS_HTML: ticketsHtml,
    // compat héritée
    payerFirstName: order.payerFirstName || order?.payer?.firstName || '',
    payerLastName:  order.payerLastName  || order?.payer?.lastName  || '',
    payerEmail:     order.payerEmail     || order?.payer?.email     || '',
    orderId:        String(order._id),
    totalEuroPlain: fmtEuroPlain(totalCents),
    installmentsInfo: humanInstallments(split),
    haOrderBlock,
    clubName: (process.env.CLUB_NAME || 'Les Bélougas'),
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
