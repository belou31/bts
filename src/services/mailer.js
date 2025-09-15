// src/services/mailer.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Tariff } from '../models/Tariff.js';
import { hexToQrSvg } from './qr.js';

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

// -- Helpers "tickets / QR" ---------------------------------------------------
function shortHex(h) {
  const s = String(h||'');
  return s.length > 12 ? (s.slice(0,6) + '…' + s.slice(-4)) : s;
}

async function buildTicketsHtml(order) {
  // tickets attendus en: order.meta.tickets = [{ seatId, tariff, hex }, ...]
  const tickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  if (!tickets.length) return '';

  // Génère les SVG en parallèle
  const svgs = await Promise.all(tickets.map(t => hexToQrSvg(t.hex, { ecl:'M', margin:1 })));

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
  // Construit (éventuellement) le bloc billets + QR pour les commandes événementielles
  const ticketsHtml = await buildTicketsHtml(order);

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
      LINES_HTML: tbh7Rows,
      TICKETS_HTML: ticketsHtml
    };
    return injectTicketsHtml(applyVars(htmlRaw, ctx), ticketsHtml);
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

  return injectTicketsHtml(applyVars(htmlRaw, ctx), ticketsHtml);
}


// NEW: attribue des codes QR "banque" selon le tarif des lignes
export async function attachQrFromBank(db, order){
  const Events = db.collection('events');
  const evId   = String(order?.meta?.eventId||'');
  if (!evId) return { ok:false, reason:'no-event' };
  const { ObjectId } = await import('mongodb');
  const ev = await Events.findOne({ _id: new ObjectId(evId) });
  if (!ev?.qrBank?.buckets) return { ok:false, reason:'no-bank' };
  const picked = [];
  for (const ln of (order?.lines||[])) {
    const list = ev.qrBank.buckets[String(ln.tariff||'NORMAL').toUpperCase()] || [];
    const hex  = list.shift(); // consomme 1 code
    if (!hex) return { ok:false, reason:'depleted' };
    picked.push({ seatId: ln.seatId, tariff: ln.tariff, hex });
  }
  // persiste la consommation
  await Events.updateOne({ _id: ev._id }, { $set: { 'qrBank.buckets': ev.qrBank.buckets } });
  return { ok:true, tickets: picked };
}
