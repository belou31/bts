// src/services/tickets-pdf.js
import fs from 'fs/promises';
import path from 'path';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { Event } from '../models/Event.js';
import { hexToQrSvg } from './qr.js';
import { Tariff } from '../models/Tariff.js';

// --- Emplacements / chemins par défaut
const DEFAULT_TEMPLATE = path.resolve(process.cwd(), 'src', 'templates', 'pdf', 'ticket.svg');
const DEFAULT_LOGO     = path.resolve(process.cwd(), 'data', 'logo.svg');

// util pour récupérer le label depuis l'évènement (fallback saison/lieu)
async function loadTariffLabelMap(ev) {
  const qEvent = ev?.priceTableKey ? { priceTableKey: ev.priceTableKey, active: true } : null;
  const tariffs = (qEvent
    ? await Tariff.find(qEvent).lean()
    : await Tariff.find({ seasonCode: ev.seasonCode, venueSlug: ev.venueSlug, active: true }).lean()
  ) || [];
  const m = {};
  for (const t of tariffs) {
    const code = String(t.code || t.tariffCode || '').toUpperCase();
    const label = t.label || t.name || code;
    if (code) m[code] = String(label);
  }
  return m;
}

// ---------- Helpers ----------
function fmtDateFR(d) {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  } catch { return ''; }
}
function seatOrZone(t) {
  // Priorité au siège réel ; fallback sur zone
  return String(t?.seatId || t?.zoneKey || '').trim();
}


// ───────── Template utils (slots + placeholders) ─────────
function escapeXml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function applyVars(svg, vars) {
  return svg.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (_m, k) => {
    const v = vars[k];
    return (v === undefined || v === null) ? '' : escapeXml(String(v));
  });
}


// Remplace un <rect id="slot"> par un <svg x/y/width/height>…</svg> qui embarque le SVG fourni
function replaceSlotWithSvg(svg, slotId, innerSvg) {
  const re  = new RegExp(`<rect\\b[^>]*\\bid=(['"])${slotId}\\1[^>]*>`, 'i');
  const m   = svg.match(re);
  if (!m) return svg;
  const tag = m[0];
  const attr = (name) => {
    const r = new RegExp(`${name}\\s*=\\s*(['"])([^"']+)\\1`, 'i').exec(tag);
    return r ? r[2] : '';
  };
  const num = (x) => (x ? parseFloat(x) : NaN);
  const x = num(attr('x')) || 0;
  const y = num(attr('y')) || 0;
  const w = num(attr('width'))  || 180;
  const h = num(attr('height')) || 180;
  const clean = sanitizeInlineSvg(innerSvg);
  const vbMatch = /viewBox\s*=\s*['"]([^'"]+)['"]/i.exec(clean);
  const vb = vbMatch ? vbMatch[1] : (() => {
    const { w: iw, h: ih } = parseSvgBoxSize(clean);
    return `0 0 ${iw} ${ih}`;
  })();
  // On enlève l’enveloppe <svg> du contenu interne si présente
  const inner = (() => {
    const mm = /<svg[^>]*>([\s\S]*?)<\/svg>/i.exec(clean);
    return mm ? mm[1] : clean;
  })();
  const inserted = `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
  return svg.replace(tag, inserted);
}


function beneficiaryForTicket(ticket, order) {
  // Essaye de retrouver la ligne correspondante (même seatId, à défaut même zoneKey)
  const lines = Array.isArray(order?.lines) ? order.lines : [];
  let ln = null;
  if (ticket?.seatId) ln = lines.find(l => String(l.seatId||'') === String(ticket.seatId||''));
  if (!ln && ticket?.zoneKey) {
    const z = String(ticket.zoneKey||'').toUpperCase();
    const tc = String(ticket.tariff || ticket.tariffCode || '').toUpperCase();
    // d’abord zone+tarif (plus précis)…
    ln = lines.find(l =>
      !l.seatId &&
      String(l.zoneKey||'').toUpperCase() === z &&
      String(l.tariffCode||'').toUpperCase() === tc
    ) || 
    // …sinon juste la zone (fallback doux)
    lines.find(l => !l.seatId && String(l.zoneKey||'').toUpperCase() === z);
  }

  const fn = ln?.holderFirstName || '';
  const lnw = ln?.holderLastName || '';
  const name = [fn, lnw].filter(Boolean).join(' ').trim();
  if (name) return name;
  return [order?.payerFirstName, order?.payerLastName].filter(Boolean).join(' ').trim();
}


// ====== Template loader/helpers =================================================

// Nettoie SVG inline (supprime <?xml…> / <!DOCTYPE…>)
function sanitizeInlineSvg(s) {
  if (!s) return '';
  return String(s)
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .trim();
}
 

// Récupère la taille "native" du SVG (via viewBox ou width/height), fallback 256
function parseSvgBoxSize(svg) {
  const vb = /viewBox\s*=\s*['"]\s*\d+(?:[\s,]+)\d+(?:[\s,]+)(\d+(?:\.\d+)?)(?:[\s,]+)(\d+(?:\.\d+)?)\s*['"]/i.exec(svg);
  if (vb) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
  const w = /width\s*=\s*['"]\s*([\d.]+)(?:px)?/i.exec(svg);
  const h = /height\s*=\s*['"]\s*([\d.]+)(?:px)?/i.exec(svg);
  if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  return { w: 256, h: 256 };
}




export async function buildTicketsPdfBuffer(order) {
  const tickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  if (!tickets.length) return null;

  const evId = String(order?.meta?.eventId || '');
  const ev = evId ? await Event.findById(evId).lean().catch(()=>null) : null;

  const tariffLabels = await loadTariffLabelMap(ev);
console.log(JSON.stringify(tariffLabels));
  // --- Charge le template & le logo (fichiers)
  const tplPath  = process.env.TICKET_SVG_TEMPLATE || DEFAULT_TEMPLATE;
  const logoPath = process.env.CLUB_LOGO_SVG_PATH || DEFAULT_LOGO;
  const rawSvg   = await fs.readFile(tplPath, 'utf8');
  let   logoSvg  = '';
  try { logoSvg = await fs.readFile(logoPath, 'utf8'); } catch {}


  return await new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', d => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const clubName = process.env.CLUB_NAME || 'Les Bélougas';
    const eventName = ev?.name || order?.meta?.eventName || 'Match';
    const eventStartsAt = ev?.startsAt || order?.createdAt;
    const venueName = ev?.venueName || ev?.venueSlug || order?.venueSlug || '';
    
    // Dimensions natives du template (ex. 595×842)
    const tplSize = parseSvgBoxSize(rawSvg);
    
    // Une page par ticket : on remplit le template texte, on pose QR & logo dans leurs slots

    for (let i = 0; i < tickets.length; i++) {
      if (i > 0) doc.addPage();
      const t = tickets[i] || {};
      // Bénéficiaire : idéalement depuis la ligne correspondante, sinon fallback payer
      const beneficiary = beneficiaryForTicket(t, order);
      const tCode = String(t?.tariff || t?.tariffCode || 'NORMAL').toUpperCase();
      const tLabel = tariffLabels[tCode] || tCode;

      // 1) Remplacement des placeholders texte
      const textSvg = applyVars(rawSvg, {
        CLUB_NAME: clubName,
        EVENT_NAME: eventName,
        EVENT_DATE: fmtDateFR(eventStartsAt),
        VENUE_NAME: venueName,
        ORDER_ID: String(order?._id || ''),
        SEAT: seatOrZone(t),
        BENEFICIARY: beneficiary,
        TARIFF_LABEL: tCode
      });

      // 2) On remplace les slots <rect id="qr|logo"> par des <svg x/y/w/h> embarquant le contenu
      let pageSvg = textSvg;
      if (t?.hex) {
        const qrSvg = await hexToQrSvg(String(t.hex), { ecl:'M', margin:0 });
        pageSvg = replaceSlotWithSvg(pageSvg, 'qr', qrSvg);
      }
      if (logoSvg) {
        pageSvg = replaceSlotWithSvg(pageSvg, 'logo', logoSvg);
      }

      // 3) Un seul rendu du SVG complet
      SVGtoPDF(doc, pageSvg, 0, 0, { width: tplSize.w, height: tplSize.h });

    }
    doc.end();
  });
}
