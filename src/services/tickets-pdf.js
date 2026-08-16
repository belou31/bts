// src/services/tickets-pdf.js
import fs from 'fs/promises';
import path from 'path';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { Event } from '../models/Event.js';
import { Venue } from '../models/Venue.js';
import { hexToQrSvg, renderQrSvg, signCode } from './qr.js';
import { Tariff } from '../models/Tariff.js';
import { AdCampaign } from '../models/AdCampaign.js';
import { AdCampaignPlacement } from '../models/AdCampaignPlacement.js';
import { isSubscriptionOrder } from '../utils/subscription.js';
import { formatDate } from '../utils/format.js';
// Aliased: this file already uses `t` as a local variable for the current
// ticket object throughout buildTicketsPdfBuffer's loop.
import { t as translate } from '../utils/i18n.js';
import { resolveThemeForOrder, resolveLogoRefForOrder, resolveOrganizationName } from './customization.js';

// --- Emplacements / chemins par défaut
const TICKET_ROOT_RUNTIME     = path.resolve(process.cwd(), 'data', 'templates');
const TICKET_CONFIG_RUNTIME   = path.resolve(TICKET_ROOT_RUNTIME, 'templates.json');
const TICKET_DIR_RUNTIME      = path.join(TICKET_ROOT_RUNTIME, 'tickets');
const DATA_ROOT_RUNTIME       = path.resolve(process.cwd(), 'data'); // data/assets/... — assets live alongside templates/, not inside it
const DEFAULT_LOGO            = path.resolve(process.cwd(), 'public', 'dynamic', 'assets', 'logo.png');

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
  const base = (await readJsonIfExists(TICKET_CONFIG_RUNTIME)) || {};
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

// theme (optional): tries "<name>.<theme>.svg" first, falls back to the
// plain "<name>.svg" if that themed variant doesn't exist yet — see
// resolveThemeForOrder() in ./customization.js.
async function resolveTicketFile(name, theme) {
  const fname = name.endsWith('.svg') ? name : `${name}.svg`;
  const candidates = [];
  if (theme) {
    const themedName = `${fname.slice(0, -'.svg'.length)}.${theme}.svg`;
    candidates.push(path.resolve(TICKET_DIR_RUNTIME, themedName), path.resolve(TICKET_ROOT_RUNTIME, themedName));
  }
  candidates.push(path.resolve(TICKET_DIR_RUNTIME, fname), path.resolve(TICKET_ROOT_RUNTIME, fname));
  for (const p of candidates) {
    if (await fs.stat(p).then(st => st.isFile()).catch(() => false)) return p;
  }
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
    const dataAsset = path.resolve(DATA_ROOT_RUNTIME, candidate);
    if (await fs.stat(dataAsset).then(st => st.isFile()).catch(() => false)) return dataAsset;
    const runtimeRoot = path.resolve(TICKET_ROOT_RUNTIME, candidate);
    if (await fs.stat(runtimeRoot).then(st => st.isFile()).catch(() => false)) return runtimeRoot;
    const absoluteFromRoot = path.resolve(process.cwd(), candidate);
    if (await fs.stat(absoluteFromRoot).then(st => st.isFile()).catch(() => false)) return absoluteFromRoot;
  }
  if (await fs.stat(DEFAULT_LOGO).then(st => st.isFile()).catch(() => false)) return DEFAULT_LOGO;
  return null;
}

// Ad campaign assets live under data/assets/ads/ (each entry in
// AdCampaign.assetPaths is relative to data/assets/, e.g.
// "ads/sponsor-x-banner.png") — same resolution idea as resolveLogoPath but
// without the app-logo fallback. Takes one path at a time (the caller has
// already picked which entry to use, e.g. via carousel rotation).
async function resolveAdAssetPath(assetPath) {
  const candidate = String(assetPath || '').trim();
  if (!candidate) return null;
  if (path.isAbsolute(candidate)) {
    return (await fs.stat(candidate).then(st => st.isFile()).catch(() => false)) ? candidate : null;
  }
  const dataAsset = path.resolve(DATA_ROOT_RUNTIME, 'assets', candidate);
  if (await fs.stat(dataAsset).then(st => st.isFile()).catch(() => false)) return dataAsset;
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

// Active ad placements applicable to this order, loaded once (same pattern
// as loadTariffLabelMap). Same dual addressing as TariffPrice: event-scoped
// (priceTableKey) takes priority; falls back to the season/venue default
// when the event has none of its own — see AdCampaignPlacement.js.
async function loadActivePlacements(ev, order) {
  const now = new Date();
  let rows = [];
  if (ev?.priceTableKey) {
    rows = await AdCampaignPlacement.find({ priceTableKey: ev.priceTableKey, active: true }).lean();
  }
  if (!rows.length) {
    const seasonCode = ev?.seasonCode || order?.seasonCode || '';
    const venueSlug = ev?.venueSlug || order?.venueSlug || order?.meta?.venueSlug || '';
    if (seasonCode && venueSlug) {
      rows = await AdCampaignPlacement.find({ seasonCode, venueSlug, priceTableKey: null, active: true }).lean();
    }
  }
  return rows.filter(p => (!p.startsAt || now >= new Date(p.startsAt)) && (!p.endsAt || now <= new Date(p.endsAt)));
}

// campaignSlug on AdCampaignPlacement is a soft reference (same relationship
// TariffPriceCatalog.tariffCode has to Tariff.code) — resolve the actual
// asset/targetUrl from AdCampaign in one batched lookup.
async function loadCampaignMasters(placements) {
  const slugs = [...new Set(placements.map(p => p.campaignSlug))];
  if (!slugs.length) return new Map();
  const docs = await AdCampaign.find({ slug: { $in: slugs }, active: true }).lean();
  return new Map(docs.map(d => [d.slug, d]));
}

// Higher score = more specific match wins when several placements target the
// same slot for the same ticket (zoneKey > zoneType > tariffCode > wildcard).
function placementSpecificity(p) {
  return (p.zoneKey ? 4 : 0) + (p.zoneType ? 2 : 0) + (p.tariffCode ? 1 : 0);
}

function placementMatchesTicket(p, ticket, zoneType) {
  if (p.tariffCode && p.tariffCode !== String(ticket?.tariff || ticket?.tariffCode || '').toUpperCase()) return false;
  if (p.zoneKey && p.zoneKey !== String(ticket?.zoneKey || '').toUpperCase()) return false;
  if (p.zoneType && p.zoneType !== zoneType) return false;
  return true;
}

// One winning placement per slot for this ticket.
function resolvePlacementsForTicket(placements, ticket, zoneType) {
  const bySlot = new Map();
  for (const p of placements) {
    if (!placementMatchesTicket(p, ticket, zoneType)) continue;
    const existing = bySlot.get(p.slot);
    if (!existing) { bySlot.set(p.slot, p); continue; }
    const score = placementSpecificity(p) * 1000 + (Number(p.priority) || 100);
    const existingScore = placementSpecificity(existing) * 1000 + (Number(existing.priority) || 100);
    if (score > existingScore) bySlot.set(p.slot, p);
  }
  return bySlot;
}

// ---------- Helpers ----------
const TICKET_TIMEZONE = process.env.TICKET_TIMEZONE || process.env.CLUB_TIMEZONE || 'Europe/Paris';

function fmtDateFR(d, locale) {
  return formatDate(d, locale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: TICKET_TIMEZONE
  });
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
  return svg.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_m, k) => {
    const v = vars[k];
    return (v === undefined || v === null) ? '' : escapeXml(String(v));
  });
}


// Localise un <rect id="slot"> et retourne son rectangle (x/y/width/height) —
// utilisé à la fois par replaceSlotWithSvg (injection SVG) et par le
// placement d'images raster (doc.image, hors pipeline SVG).
function computeSlotRect(svg, slotId) {
  const re  = new RegExp(`<rect\\b[^>]*\\bid=(['"])${slotId}\\1[^>]*>`, 'i');
  const m   = svg.match(re);
  if (!m) return null;
  const tag = m[0];
  const attr = (name) => {
    const r = new RegExp(`${name}\\s*=\\s*(['"])([^"']+)\\1`, 'i').exec(tag);
    return r ? r[2] : '';
  };
  const num = (x) => (x ? parseFloat(x) : NaN);
  return {
    tag,
    x: num(attr('x')) || 0,
    y: num(attr('y')) || 0,
    width: num(attr('width'))  || 180,
    height: num(attr('height')) || 180
  };
}

// Remplace un <rect id="slot"> par un groupe <g> positionné/scalé avec le SVG fourni
// Évite les balises <svg> imbriquées (qui perturbent svg-to-pdfkit) en projetant le contenu.
function replaceSlotWithSvg(svg, slotId, innerSvg) {
  const rect = computeSlotRect(svg, slotId);
  if (!rect) return svg;
  const { tag, x, y, width: w, height: h } = rect;
  const clean = sanitizeEmbeddedSvg(innerSvg);
  const vbMatch = /viewBox\s*=\s*['"]([^'"]+)['"]/i.exec(clean);
  let { w: iw, h: ih } = vbMatch
    ? (() => {
        const parts = vbMatch[1].trim().split(/\s+/);
        const vw = parseFloat(parts[2]) || 0;
        const vh = parseFloat(parts[3]) || 0;
        return { w: vw || 1, h: vh || 1 };
      })()
    : parseSvgBoxSize(clean);
  if (!iw || iw <= 0) iw = 1;
  if (!ih || ih <= 0) ih = 1;

  // On enlève l’enveloppe <svg> du contenu interne si présente
  const inner = (() => {
    const mm = /<svg[^>]*>([\s\S]*?)<\/svg>/i.exec(clean);
    return mm ? mm[1] : clean;
  })();

  // Mise à l’échelle proportionnelle pour rentrer dans le slot (preserveAspectRatio="xMidYMid meet")
  const scale = Math.min(w / iw, h / ih);
  const tx = x + (w - iw * scale) / 2;
  const ty = y + (h - ih * scale) / 2;

  const inserted = `<g transform="translate(${tx},${ty}) scale(${scale})">${inner}</g>`;
  return svg.replace(tag, inserted);
}


// Essaye de retrouver la ligne de commande correspondant à ce ticket (même
// seatId, à défaut même zoneKey[+tarif]) — utilisé pour le bénéficiaire et
// pour zoneType (Order.LineSchema en porte un, pas les tickets meta).
function findOrderLineForTicket(ticket, order) {
  const lines = Array.isArray(order?.lines) ? order.lines : [];
  const metaTickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];

  const metaIndex = metaTickets.indexOf(ticket);
  if (metaIndex >= 0 && metaIndex < lines.length && lines[metaIndex]) {
    return lines[metaIndex];
  }

  if (ticket?.seatId) {
    const bySeat = lines.find(l => String(l.seatId||'') === String(ticket.seatId||''));
    if (bySeat) return bySeat;
  }
  if (ticket?.zoneKey) {
    const z = String(ticket.zoneKey||'').toUpperCase();
    const tc = String(ticket.tariff || ticket.tariffCode || '').toUpperCase();
    // d’abord zone+tarif (plus précis)…
    return lines.find(l =>
      !l.seatId &&
      String(l.zoneKey||'').toUpperCase() === z &&
      String(l.tariffCode||'').toUpperCase() === tc
    ) ||
    // …sinon juste la zone (fallback doux)
    lines.find(l => !l.seatId && String(l.zoneKey||'').toUpperCase() === z) ||
    null;
  }
  return null;
}

function zoneTypeForTicket(ticket, order) {
  const ln = findOrderLineForTicket(ticket, order);
  return ln?.zoneType || null;
}

function beneficiaryForTicket(ticket, order) {
  const ln = findOrderLineForTicket(ticket, order);

  const metaTickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  const lines = Array.isArray(order?.lines) ? order.lines : [];
  const metaIndex = metaTickets.indexOf(ticket);
  if (metaIndex >= 0 && metaIndex < lines.length) {
    const byIndex = lines[metaIndex] || {};
    const idxName = [byIndex.holderFirstName, byIndex.holderLastName].filter(Boolean).join(' ').trim();
    if (idxName) return idxName;
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

// Nettoyage supplémentaire pour les SVG embarqués (logo/QR) : on enlève les
// attributs/éléments de métadonnées (inkscape:, sodipodi:, metadata…) qui
// perturbent svg-to-pdfkit.
function sanitizeEmbeddedSvg(raw) {
  let out = sanitizeInlineSvg(raw);
  // Supprime les blocs <metadata>…</metadata>
  out = out.replace(/<metadata[\s\S]*?<\/metadata>/gi, '');
  // Supprime les éléments vides Inkscape/Sodipodi
  out = out.replace(/<\s*(?:sodipodi|inkscape):[^>]*\/?>/gi, '');
  // Supprime les attributs namespacés courants
  out = out.replace(/\s+(?:sodipodi|inkscape|xml:space|xmlns:[\w:-]+)=\"[^\"]*\"/gi, '');
  return out;
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
  const adPlacements = await loadActivePlacements(ev, order);
  const campaignMasters = await loadCampaignMasters(adPlacements);
  const appBase = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const subscriptionMode = isSubscriptionOrder(order);

  const kind = ev ? 'event' : (subscriptionMode ? 'subscription' : 'public');
  const config = await loadTicketConfig();
  const tplEntry = config[kind] || config.default;
  const theme = resolveThemeForOrder(order);

  // --- Charge le template & le logo (fichiers)
  const tplPathEnv = process.env.TICKET_SVG_TEMPLATE;
  let tplPath = null;
  if (tplPathEnv && await fs.stat(tplPathEnv).then(st => st.isFile()).catch(()=>false)) {
    tplPath = tplPathEnv;
  } else {
    tplPath = await resolveTicketFile(tplEntry?.file || 'ticket.svg', theme);
  }
  if (!tplPath) throw new Error('Ticket template not found (see data/templates/templates.json under tickets.templates)');
  console.info(`[tickets-pdf] using ticket template: ${tplPath}`);
  const rawSvg   = sanitizeInlineSvg(await fs.readFile(tplPath, 'utf8'));

  const logoPathEnv = process.env.CLUB_LOGO_SVG_PATH;
  const customLogo = resolveLogoRefForOrder(order);
  const logoPath = logoPathEnv || customLogo || (tplEntry?.logo ?? null);
  let logoSvg  = '';
  const resolvedLogo = await resolveLogoPath(logoPath);
  if (resolvedLogo) {
    const ext = path.extname(resolvedLogo).toLowerCase();
    if (ext === '.svg') {
      try { logoSvg = sanitizeEmbeddedSvg(await fs.readFile(resolvedLogo, 'utf8')); } catch {/* ignore */}
    } else {
      console.warn(`[tickets-pdf] logo is not SVG (${resolvedLogo}), skipping inline logo`);
    }
  }


  return await new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', d => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const clubName = resolveOrganizationName();
    const eventName = ev?.name || order?.meta?.eventName || translate('common.match', order?.locale);
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
      const tariffTitle = subscriptionMode
        ? translate('common.subscription', order?.locale).toUpperCase()
        : translate('common.tariff', order?.locale);

      // Contenu publicitaire applicable à CE billet (tariffCode/zoneKey/zoneType) —
      // un placement gagnant par slot, voir resolvePlacementsForTicket.
      const ticketZoneType = zoneTypeForTicket(t, order);
      const matchedPlacements = resolvePlacementsForTicket(adPlacements, t, ticketZoneType);

      // contentType='text' billets on the {{TOKEN}} mechanism below — image/qr
      // use the <rect id="slot"> mechanism further down instead.
      const campaignTextVars = {};
      for (const [slot, placement] of matchedPlacements) {
        if (placement.contentType === 'text') campaignTextVars[slot.toUpperCase()] = placement.text || '';
      }

      // 1) Remplacement des placeholders texte
      const textSvg = applyVars(rawSvg, {
        CLUB_NAME: clubName,
        EVENT_NAME: eventName,
        EVENT_DATE: fmtDateFR(eventStartsAt, order?.locale),
        VENUE_NAME: resolvedVenueName,
        ORDER_ID: String(order?._id || ''),
        SEAT: seatOrZone(t),
        BENEFICIARY: beneficiary,
        TARIFF_LABEL: resolvedTariffLabel,
        TARIFF_TITLE: tariffTitle,
        LABEL_VENUE: translate('common.venue', order?.locale),
        LABEL_SEAT: translate('common.seat', order?.locale),
        LABEL_BENEFICIARY: translate('common.beneficiary', order?.locale),
        FOOTER_NOTE: translate('ticket.footerNote', order?.locale, { orderId: String(order?._id || '') }),
        ...campaignTextVars
      });

      // 2) On remplace les slots <rect id="qr|logo"> par des <svg x/y/w/h> embarquant le contenu
    let pageSvg = textSvg;
    // — Injection des slots (QR + logo). On essaie plusieurs variantes si la
    // librairie SVG→PDF remonte des erreurs de parsing.
    const attemptRender = async (svgSource, label) => {
      try {
        SVGtoPDF(doc, svgSource, 0, 0, { width: tplSize.w, height: tplSize.h });
        return true;
      } catch (err) {
        console.warn(`[tickets-pdf] SVG render failed (${label}): ${err.message || err}`);
        return false;
      }
    };

    // Variante complète (QR + logo si dispo)
    // Slots raster (image) : pas d'injection SVG, juste les coordonnées —
    // dessinés avec doc.image() une fois la page rendue (voir plus bas).
    const pendingRasterDraws = [];
    try {
      if (t?.hex) {
        const qrSvg = await hexToQrSvg(String(t.hex), { ecl:'M', margin:0 });
        pageSvg = replaceSlotWithSvg(pageSvg, 'qr', qrSvg);
      }
      if (logoSvg) {
        pageSvg = replaceSlotWithSvg(pageSvg, 'logo', logoSvg);
      }
      for (const [slot, placement] of matchedPlacements) {
        if (placement.contentType === 'text') continue; // already folded into textSvg above

        const campaign = campaignMasters.get(placement.campaignSlug);
        if (!campaign) {
          console.warn(`[tickets-pdf] ad placement references unknown/inactive campaign "${placement.campaignSlug}", skipping slot "${slot}"`);
          continue;
        }

        if (placement.contentType === 'image') {
          if (!campaign.assetPaths?.length) continue; // identity registered, no asset yet
          // Carousel: rotate through a multi-asset campaign by this ticket's
          // position within its order — deterministic, so a resent/
          // regenerated ticket always shows the same one.
          const chosenAssetPath = campaign.assetPaths[i % campaign.assetPaths.length];
          if (campaign.assetKind === 'svg') {
            const resolvedAsset = await resolveAdAssetPath(chosenAssetPath);
            if (resolvedAsset) {
              try {
                const assetSvg = sanitizeEmbeddedSvg(await fs.readFile(resolvedAsset, 'utf8'));
                pageSvg = replaceSlotWithSvg(pageSvg, slot, assetSvg);
              } catch (e) {
                console.warn(`[tickets-pdf] ad asset read failed (${resolvedAsset}): ${e.message || e}`);
              }
            }
          } else if (campaign.assetKind === 'raster') {
            const resolvedAsset = await resolveAdAssetPath(chosenAssetPath);
            if (resolvedAsset) {
              const rect = computeSlotRect(rawSvg, slot);
              if (rect) pendingRasterDraws.push({ rect, path: resolvedAsset });
            }
          }
        } else if (placement.contentType === 'qr') {
          // This placement's own raw value wins (no tracking); otherwise
          // fall back to the campaign's targetUrl as a trackable /promo/
          // redirect. A campaign can have BOTH: one 'qr' row with its own
          // qrValue in one slot, another with none (falls back) in another.
          let qrText = placement.qrValue || null;
          if (!qrText && campaign.targetUrl && appBase) {
            const payload = `${campaign.slug}|${String(t?.ticketId || t?.hex || '')}|${String(order?._id || '')}`;
            qrText = `${appBase}/promo/${encodeURIComponent(signCode(payload))}`;
          }
          if (qrText) {
            const qrSvg = await renderQrSvg({ text: qrText, size: 256 });
            pageSvg = replaceSlotWithSvg(pageSvg, slot, qrSvg);
          }
        }
      }
    } catch (e) {
      console.warn('[tickets-pdf] slot injection failed, will try fallbacks', e?.message || e);
      pageSvg = textSvg;
      pendingRasterDraws.length = 0;
    }

    let rendered = await attemptRender(pageSvg, 'full');

    // Fallback 1: sans logo
    if (!rendered && logoSvg) {
      let noLogo = textSvg;
      try {
        if (t?.hex) {
          const qrSvg = await hexToQrSvg(String(t.hex), { ecl:'M', margin:0 });
          noLogo = replaceSlotWithSvg(noLogo, 'qr', qrSvg);
        }
      } catch {/* ignore */}
      rendered = await attemptRender(noLogo, 'no-logo');
    }

    // Fallback 2: template sans slots (juste texte)
    if (!rendered) {
      rendered = await attemptRender(textSvg, 'no-slots');
      if (!rendered) throw new Error('SVG render failed for ticket page');
    }

    // Images raster des campagnes pub : dessinées par-dessus la page une fois
    // le SVG de base rendu (svg-to-pdfkit ne gère pas <image> par ce chemin).
    for (const draw of pendingRasterDraws) {
      try {
        doc.image(draw.path, draw.rect.x, draw.rect.y, {
          fit: [draw.rect.width, draw.rect.height],
          align: 'center',
          valign: 'center'
        });
      } catch (e) {
        console.warn(`[tickets-pdf] raster ad image failed (${draw.path}): ${e.message || e}`);
      }
    }

  }
  doc.end();
  });
}
