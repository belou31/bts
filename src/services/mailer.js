// src/services/mailer.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import svgToPdf from 'svg-to-pdfkit';
import { Tariff } from '../models/Tariff.js';
import { hexToQrSvg } from './qr.js';
import { currentPaymentProviderLabel } from './payments/index.js';

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
  // ➤ Priorité: une commande “match” porte meta.eventId → kind = 'event'
  if (order?.meta?.eventId) return 'event';
  // Compat existant : champs optionnels
  if (order.mailTemplateKind) return String(order.mailTemplateKind).toLowerCase();
  if (order.origin?.flow)     return String(order.origin.flow).toLowerCase();
  const phase = String(order.phase || '').toLowerCase();
  if (['renew','subscription','event','public'].includes(phase)) return phase;
  return 'renew';
}


const TEMPLATE_BY_KIND = {
  renew:         'renew-confirmation',
  subscription:  'subscription-confirmation',   // (ex-public-confirmation renommé)
  event:         'event-confirmation',
  public:         'public-confirmation'
};

const SUBJECT_BY_KIND = {
  renew:         process.env.EMAIL_SUBJECT_RENEW_CONFIRM         || 'Confirmation – Abonnement (Renouvellement)',
  subscription:  process.env.EMAIL_SUBJECT_SUBSCRIPTION_CONFIRM  || 'Confirmation – Abonnement',
  event:         process.env.EMAIL_SUBJECT_EVENT_CONFIRM         || 'Confirmation – Billetterie (Match)',
  public:         process.env.EMAIL_SUBJECT_PUBLIC_CONFIRM         || 'Confirmation'
};

async function loadTemplateHtml(name) {
  const fname = `${name}.html`;
  const p = path.join(EMAIL_DIR, fname);
  return fs.readFile(p, 'utf8');
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
  if (kind === 'event') {
    const ename = order?.meta?.eventName || order?.meta?.eventSlug || 'Match';
    const base  = process.env.EMAIL_SUBJECT_EVENT_CONFIRM || 'Confirmation – Billetterie';
    return `${base} — ${ename}`;
  }

  return SUBJECT_BY_KIND[kind] || SUBJECT_BY_KIND.renew;
}

/**
  * Render email HTML for an Order, using the right template and context.
  * Works with your two current templates:
  *  - renew-confirmation.html (expects {{linesRows}}, {{installmentsInfo}}, etc.)
  *  - tbh7-confirmation.html / subscription-confirmation.html
  *    (expect {{LINES_HTML}} and nested objects)
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
    ? `<p>Référence ${currentPaymentProviderLabel()} : <b>${haOrderId}</b></p>`
    : '';

  // Rendu unique (4 colonnes) → LINES_HTML
  const _lines = Array.isArray(order.lines) ? order.lines : [];
  const normalized = _lines.map(l => normalizeLine(l, tariffsMap));
  const LINES_HTML = normalized.map(c =>
    `<tr><td>${c.seat}</td><td>${c.beneficiary}</td><td>${c.tariff}</td><td>${c.priceRich}</td></tr>`
  ).join('');

  const htmlRaw = await loadTemplateHtml(tplName);
  // Pas de QR inline pour "event" (ils seront en PDF joint).
  const ticketsHtml = (tplName === 'event-confirmation') ? '' : await buildTicketsHtml(order);

  if (tplName === 'event-confirmation') {
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

// === NEW: génère un PDF (1 page / billet) à partir de order.meta.tickets ===
export async function buildTicketsPdfBuffer(order) {
  const tickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  if (!tickets.length) return null;

  return await new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 36 });
      const chunks = [];
      doc.on('data', (d) => chunks.push(d));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const title  = order?.meta?.eventName || order?.meta?.eventSlug || 'Match';
      const season = order?.seasonCode || '';
      const venue  = order?.venueSlug  || '';

      for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i];
        if (i > 0) doc.addPage();

        // En-tête
        doc.fontSize(18).text(`Les Bélougas — ${title}`);
        doc.moveDown(0.2);
        doc.fontSize(11).fillColor('#666').text(`Saison: ${season} — Lieu: ${venue}`);
        doc.fillColor('#000').moveDown(1);

        // Détails
        const seat = t.seatId || t.zoneKey || '';
        doc.fontSize(14).text(`Place: ${seat}`);
        doc.moveDown(0.2);
        doc.fontSize(12).text(`Tarif: ${String(t.tariff||'NORMAL').toUpperCase()}`);
        doc.moveDown(1);

        // QR (SVG → PDF)
        const svg = await hexToQrSvg(t.hex, { ecl: 'M', margin: 1 });
        const svgStr = String(svg); // évite getElementsByTagName is not a function
        svgToPdf(doc, svgStr, 360, 150, { width: 180, height: 180, preserveAspectRatio: 'xMidYMid meet' });

        // Encadré d’info
        doc.roundedRect(36, 340, 300, 80, 8).stroke();
        doc.text('Présentez ce billet à l’entrée.\nConservez-le jusqu’à la fin de l’événement.',
                 48, 350, { width: 276 });
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}  




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
