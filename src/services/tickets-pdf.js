// src/services/tickets-pdf.js
import fs from 'fs/promises';
import path from 'path';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { Event } from '../models/Event.js';
import { Venue } from '../models/Venue.js';
import { hexToQrSvg } from './qr.js';
import { Tariff } from '../models/Tariff.js';
import { isSubscriptionOrder } from '../utils/subscription.js';

// --- Emplacements / chemins par défaut
const TICKET_ROOT_RUNTIME     = path.resolve(process.cwd(), 'data', 'templates');
const TICKET_ROOT_REF         = path.resolve(process.cwd(), 'data_references', 'templates');
const TICKET_CONFIG_RUNTIME   = path.resolve(TICKET_ROOT_RUNTIME, 'templates.json');
const TICKET_CONFIG_TEMPLATE  = path.resolve(TICKET_ROOT_REF, 'templates.json');
const TICKET_DIR_RUNTIME      = path.join(TICKET_ROOT_RUNTIME, 'tickets');
const TICKET_DIR_DATA         = path.join(TICKET_ROOT_REF, 'tickets');
const DEFAULT_LOGO            = path.resolve(process.cwd(), 'public', 'dynamic', 'assets', 'logo.svg');

const DEFAULT_TICKET_CONFIG = {
  templates: {
    default: {
      file: 'ticket.svg',
      logo: 'dynamic/assets/logo.svg'
    },
    subscription: {
      file: 'ticket.svg',
      logo: 'dynamic/assets/logo.svg'
    },
    event: {
      file: 'ticket.svg',
      logo: 'dynamic/assets/logo.svg'
    },
    public: {
      file: 'ticket.svg',
      logo: 'dynamic/assets/logo.svg'
    }
  }
};

let TICKET_CONFIG_CACHE = null;

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadTicketConfig() {
  if (TICKET_CONFIG_CACHE) return TICKET_CONFIG_CACHE;
  const custom = await readJsonIfExists(TICKET_CONFIG_RUNTIME);
  const templ  = await readJsonIfExists(TICKET_CONFIG_TEMPLATE);
  const base = custom || templ || {};
  const section =
    (base.tickets && base.tickets.templates)
    || (base.templates && base.templates.tickets)
    || base.templates
    || base.tickets
    || {};
  const merged = { ...DEFAULT_TICKET_CONFIG.templates };

  if (section && typeof section === 'object') {
    for (const [key, entry] of Object.entries(section)) {
      if (!entry || typeof entry !== 'object') continue;
      const file = entry.file || entry.template || entry.name;
      if (!file) continue;
      merged[key] = {
        file,
        logo: entry.logo || merged[key]?.logo || null
      };
    }
  }

  TICKET_CONFIG_CACHE = merged;
  return merged;
}

async function resolveTicketFile(name) {
  const fname = name.endsWith('.svg') ? name : `${name}.svg`;
  const runtimePath = path.resolve(TICKET_DIR_RUNTIME, fname);
  if (await fs.stat(runtimePath).then(st => st.isFile()).catch(() => false)) return runtimePath;
  const dataPath = path.resolve(TICKET_DIR_DATA, fname);
  if (await fs.stat(dataPath).then(st => st.isFile()).catch(() => false)) return dataPath;
  const rootRuntimePath = path.resolve(TICKET_ROOT_RUNTIME, fname);
  if (await fs.stat(rootRuntimePath).then(st => st.isFile()).catch(() => false)) return rootRuntimePath;
  const rootRefPath = path.resolve(TICKET_ROOT_REF, fname);
  if (await fs.stat(rootRefPath).then(st => st.isFile()).catch(() => false)) return rootRefPath;
  // Absolute path provided
  if (path.isAbsolute(name) && await fs.stat(name).then(st => st.isFile()).catch(() => false)) return name;
  return null;
}

async function resolveLogoPath(logoRef) {
  const candidate = logoRef || '';
  if (path.isAbsolute(candidate)) {
    if (await fs.stat(candidate).then(st => st.isFile()).catch(() => false)) return candidate;
  } else if (candidate) {
    const runtime = path.resolve(TICKET_DIR_RUNTIME, candidate);
    if (await fs.stat(runtime).then(st => st.isFile()).catch(() => false)) return runtime;
    const data = path.resolve(TICKET_DIR_DATA, candidate);
    if (await fs.stat(data).then(st => st.isFile()).catch(() => false)) return data;
    const runtimeRoot = path.resolve(TICKET_ROOT_RUNTIME, candidate);
    if (await fs.stat(runtimeRoot).then(st => st.isFile()).catch(() => false)) return runtimeRoot;
    const refRoot = path.resolve(TICKET_ROOT_REF, candidate);
    if (await fs.stat(refRoot).then(st => st.isFile()).catch(() => false)) return refRoot;
    const absoluteFromRoot = path.resolve(process.cwd(), candidate);
    if (await fs.stat(absoluteFromRoot).then(st => st.isFile()).catch(() => false)) return absoluteFromRoot;
  }
  if (await fs.stat(DEFAULT_LOGO).then(st => st.isFile()).catch(() => false)) return DEFAULT_LOGO;
  return null;
}

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
const TICKET_TIMEZONE = process.env.TICKET_TIMEZONE || process.env.CLUB_TIMEZONE || 'Europe/Paris';

function fmtDateFR(d) {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleString('fr-FR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: TICKET_TIMEZONE
    });
  } catch { return ''; }
}
function seatOrZone(t) {
  // Pour les billets fallback on affiche la zone uniquement
  if (t?.fallback) return String(t?.zoneKey || '').trim();
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
  const lines = Array.isArray(order?.lines) ? order.lines : [];
  const metaTickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];

  const metaIndex = metaTickets.indexOf(ticket);
  if (metaIndex >= 0 && metaIndex < lines.length) {
    const byIndex = lines[metaIndex] || {};
    const idxName = [byIndex.holderFirstName, byIndex.holderLastName].filter(Boolean).join(' ').trim();
    if (idxName) return idxName;
  }

  // Essaye de retrouver la ligne correspondante (même seatId, à défaut même zoneKey)
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

  const ticketName = [ticket?.holderFirstName, ticket?.holderLastName].filter(Boolean).join(' ').trim();
  if (ticketName) return ticketName;

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
  const subscriptionMode = isSubscriptionOrder(order);

  const kind = ev ? 'event' : (subscriptionMode ? 'subscription' : 'public');
  const config = await loadTicketConfig();
  const tplEntry = config[kind] || config.default;

  // --- Charge le template & le logo (fichiers)
  const tplPathEnv = process.env.TICKET_SVG_TEMPLATE;
  let tplPath = null;
  if (tplPathEnv && await fs.stat(tplPathEnv).then(st => st.isFile()).catch(()=>false)) {
    tplPath = tplPathEnv;
  } else {
    tplPath = await resolveTicketFile(tplEntry?.file || 'ticket.svg');
  }
  if (!tplPath) throw new Error('Ticket template not found (see data/templates/templates.json under tickets.templates)');
  const rawSvg   = await fs.readFile(tplPath, 'utf8');

  const logoPathEnv = process.env.CLUB_LOGO_SVG_PATH;
  const logoPath = logoPathEnv || (tplEntry?.logo ?? null);
  let logoSvg  = '';
  const resolvedLogo = await resolveLogoPath(logoPath);
  if (resolvedLogo) {
    try { logoSvg = await fs.readFile(resolvedLogo, 'utf8'); } catch {/* ignore */}
  }


  return await new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', d => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const clubName = process.env.CLUB_NAME || 'Les Bélougas';
    const eventName = ev?.name || order?.meta?.eventName || 'Match';
    const eventStartsAt = ev?.startsAt || order?.createdAt;
    let venueName = ev?.venueName || '';
    const venueSlug = ev?.venueSlug || order?.venueSlug || order?.meta?.venueSlug || '';
    if (!venueName && venueSlug) {
      try {
        const venueDoc = await Venue.findOne({ slug: venueSlug }).lean();
        venueName = venueDoc?.name || '';
      } catch {/* ignore */}
    }
    const resolvedVenueName = venueName || venueSlug || '';
    
    // Dimensions natives du template (ex. 595×842)
    const tplSize = parseSvgBoxSize(rawSvg);
    
    // Une page par ticket : on remplit le template texte, on pose QR & logo dans leurs slots

    for (let i = 0; i < tickets.length; i++) {
      if (i > 0) doc.addPage();
      const t = tickets[i] || {};
      // Bénéficiaire : idéalement depuis la ligne correspondante, sinon fallback payer
      const beneficiary = beneficiaryForTicket(t, order);
      const tCode = String(t?.tariff || t?.tariffCode || 'NORMAL');
      const tLabel = tariffLabels[tCode] || tCode;
      const resolvedTariffLabel = tLabel;
      const tariffTitle = subscriptionMode ? 'ABONNEMENT' : 'Tarif';

      // 1) Remplacement des placeholders texte
      const textSvg = applyVars(rawSvg, {
        CLUB_NAME: clubName,
        EVENT_NAME: eventName,
        EVENT_DATE: fmtDateFR(eventStartsAt),
        VENUE_NAME: resolvedVenueName,
        ORDER_ID: String(order?._id || ''),
        SEAT: seatOrZone(t),
        BENEFICIARY: beneficiary,
        TARIFF_LABEL: resolvedTariffLabel,
        TARIFF_TITLE: tariffTitle
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
