
// src/routes/scan.js (ESM)
import express from 'express';
import mongoose, { isValidObjectId } from 'mongoose';
import { Ticket } from '../models/Ticket.js';
import { Order } from '../models/Order.js';
import { Event } from '../models/Event.js';
import { Tariff } from '../models/Tariff.js';
import { ScanLog } from '../models/ScanLog.js';
import { verifySignature, renderQrSvg } from '../services/qr.js';

function basePath() {
  // "" en DEV, "/bts" en INT/PROD (ou ce que tu définis)
  return process.env.BASE_PATH || '';
}

const router = express.Router();

function parseBasic(header) {
  try {
    const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return { login: '', password: '' };
    return {
      login: decoded.slice(0, idx),
      password: decoded.slice(idx + 1)
    };
  } catch {
    return { login: '', password: '' };
  }
}

function requireScanner(req, res, next) {
  const envToken = String(process.env.SCANNER_TOKEN || '').trim();
  const envLogin = String(process.env.SCAN_LOGIN || '').trim();
  const envPassword = String(process.env.SCAN_PASSWORD || '').trim();

  const header = String(req.headers.authorization || '');
  let token = '';
  let login = '';
  let password = '';

  if (/^Bearer\s+/i.test(header)) {
    token = header.replace(/^Bearer\s+/i, '').trim();
  } else if (/^Basic\s+/i.test(header)) {
    ({ login, password } = parseBasic(header));
  }

  token = token || String(req.query.token || req.query.bearer || req.body?.token || '').trim();

  if (!login && !password) {
    const qLogin = String(req.query.login || req.query.user || '').trim();
    const qPassword = String(req.query.password || req.query.pass || '').trim();
    if (qLogin && qPassword) {
      login = qLogin;
      password = qPassword;
    }
  }

  let ok = false;
  if (token && envToken && token === envToken) ok = true;
  if (!ok && login && envLogin && envPassword && login === envLogin && password === envPassword) ok = true;

  if (!ok) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  req.scannerAuth = { token, login };
  next();
}

const EVENT_CACHE_TTL_MS = 60 * 1000;
const eventCache = new Map();
const ALLOWED_CTRL_CODES = new Set([9, 10, 13]);

function extractLookupVariants(rawValue) {
  const variants = new Set();
  const base = String(rawValue || '').trim();
  if (!base) return variants;
  variants.add(base);

  const containsCtrl = (str) => {
    for (const ch of str) {
      const code = ch.charCodeAt(0);
      if ((code >= 0 && code < 32 && !ALLOWED_CTRL_CODES.has(code)) || code === 127) {
        return true;
      }
    }
    return false;
  };

  const pushIfAscii = (candidate) => {
    if (!candidate) return;
    const str = String(candidate).trim();
    if (!str || containsCtrl(str)) return;
    variants.add(str);
  };

  const pushFragmentVariants = (value) => {
    const collapsed = value.replace(/\s+/g, '');
    if (collapsed && collapsed !== value) pushIfAscii(collapsed);
    if (value.includes(':')) {
      const parts = value.split(':').map((part) => part.trim()).filter(Boolean);
      if (parts.length >= 2) {
        pushIfAscii(parts[0]);
        pushIfAscii(parts.slice(1).join(':'));
      }
    }
  };

  const attemptBase64 = (value) => {
    try {
      if (!value || value.length % 4 !== 0) return;
      if (!/^[A-Za-z0-9+/=]+$/.test(value)) return;
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      pushIfAscii(decoded);
      pushFragmentVariants(decoded);
    } catch {}
  };

  attemptBase64(base);

  if (/^[A-Za-z0-9_-]+=?=?$/.test(base)) {
    const normalized = base.replace(/-/g, '+').replace(/_/g, '/');
    attemptBase64(normalized);
  }

  pushFragmentVariants(base);

  return variants;
}

async function resolveEventKey(eventIdOrSlug) {
  const raw = String(eventIdOrSlug || '').trim();
  if (!raw) {
    const err = new Error('event_required');
    err.code = 'EVENT_REQUIRED';
    throw err;
  }

  const cached = eventCache.get(raw);
  if (cached && (Date.now() - cached.cachedAt) < EVENT_CACHE_TTL_MS) {
    return cached;
  }

  const projection = { _id: 1, slug: 1, priceTableKey: 1, seasonCode: 1, venueSlug: 1 };
  let doc = null;
  if (isValidObjectId(raw)) {
    doc = await Event.findById(new mongoose.Types.ObjectId(raw), projection).lean();
  }
  if (!doc) {
    doc = await Event.findOne({ slug: raw }, projection).lean();
  }

  if (!doc) {
    const err = new Error('event_not_found');
    err.code = 'EVENT_NOT_FOUND';
    throw err;
  }

  const canonicalId = String(doc._id);
  const result = {
    id: canonicalId,
    slug: doc.slug || raw,
    cachedAt: Date.now(),
    doc
  };
  eventCache.set(raw, result);
  return result;
}

// ---------- API helpers ----------
function normalizeId(value) {
  return value ? String(value) : '';
}

function normalizeTariffCode(value) {
  return String(value || '').trim().toUpperCase();
}

function buildTariffLookupMap(tariffDocs = [], eventDoc = null) {
  const byCode = new Map();
  for (const doc of tariffDocs || []) {
    const code = normalizeTariffCode(doc?.code);
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(doc);
  }

  const lookup = new Map();
  for (const [code, docs] of byCode.entries()) {
    if (!Array.isArray(docs) || !docs.length) continue;
    let chosen = null;
    const priceTableKey = eventDoc?.priceTableKey ? String(eventDoc.priceTableKey) : null;
    if (priceTableKey) {
      chosen = docs.find((d) => String(d?.priceTableKey || '') === priceTableKey) || null;
    }
    if (!chosen && eventDoc?.seasonCode && eventDoc?.venueSlug) {
      const season = String(eventDoc.seasonCode || '').toLowerCase();
      const venue = String(eventDoc.venueSlug || '').toLowerCase();
      chosen = docs.find((d) =>
        String(d?.seasonCode || '').toLowerCase() === season &&
        String(d?.venueSlug || '').toLowerCase() === venue
      ) || null;
    }
    if (!chosen) {
      chosen = docs.find((d) => !d?.priceTableKey) || null;
    }
    if (!chosen) chosen = docs[0];
    if (chosen) lookup.set(code, chosen);
  }

  return lookup;
}

function buildConditions(line = {}, metaTicket = {}) {
  line = line || {};
  metaTicket = metaTicket || {};
  const out = [];
  const seen = new Set();
  for (const raw of [line?.justif, line?.justificationField, line?.info, metaTicket?.note]) {
    const txt = String(raw ?? '').trim();
    if (!txt || seen.has(txt)) continue;
    seen.add(txt);
    out.push(txt);
  }
  return out;
}


function composeMatch(ticketDoc, orderDoc, eventId, eventSlug, options = {}) {
  const {
    orderStats = null,
    orderTicketMap = new Map(),
    isPrimary = false,
    tariffLookup = null
  } = options || {};

  const ticket = ticketDoc?.toObject ? ticketDoc.toObject() : ticketDoc;
  if (!ticket) return null;

  const order = orderDoc?.toObject ? orderDoc.toObject() : orderDoc;
  const orderId = normalizeId(ticket.orderId);
  const statsSource = orderStats instanceof Map ? orderStats : null;
  const stats = statsSource ? statsSource.get(orderId) : null;
  let totalTickets = stats?.total ?? null;
  let scannedTickets = stats?.scanned ?? null;

  const eventIdNorm = normalizeId(eventId);
  const eventSlugNorm = String(eventSlug || '').toLowerCase();
  const ticketEventNorm = normalizeId(ticket.eventId);
  const ticketSlugNorm = String(ticket.eventId || '').toLowerCase();
  const orderMetaEventId = normalizeId(order?.meta?.eventId);
  const orderMetaSlugNorm = String(order?.meta?.eventSlug || '').toLowerCase();

  const sameEvent = [ticketEventNorm, ticketSlugNorm, orderMetaEventId, orderMetaSlugNorm]
    .filter(Boolean)
    .some((val) => {
      const norm = typeof val === 'string' ? val.toLowerCase() : String(val).toLowerCase();
      return norm === eventIdNorm || norm === eventSlugNorm;
    });

  const status = sameEvent ? (ticket.scannedAt ? 'already_scanned' : 'ready') : 'wrong_event';

  const metaTickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  if ((totalTickets == null || totalTickets === 0) && metaTickets.length) totalTickets = metaTickets.length;
  if (scannedTickets == null && stats?.scanned != null) scannedTickets = stats.scanned;

  const metaTicket = metaTickets.find((mt) => {
    if (!mt) return false;
    if (mt.ticketId && normalizeId(mt.ticketId) === normalizeId(ticket._id)) return true;
    if (mt.hex && ticket.qr?.value && String(mt.hex) === String(ticket.qr.value)) return true;
    if (ticket.seatId && String(mt.seatId || '').trim().toLowerCase() === String(ticket.seatId).trim().toLowerCase()) return true;
    return false;
  }) || null;

  const lines = Array.isArray(order?.lines) ? order.lines : [];
  if ((totalTickets == null || totalTickets === 0) && lines.length) totalTickets = lines.length;
  const seatId = String(ticket.seatId || metaTicket?.seatId || '').trim();
  const zoneKey = String(metaTicket?.zoneKey || '').toUpperCase();

  let ticketIndex = null;
  if (metaTicket) {
    const idx = metaTickets.findIndex((mt) => {
      if (!mt) return false;
      if (mt.ticketId && normalizeId(mt.ticketId) === normalizeId(ticket._id)) return true;
      if (mt.hex && ticket.qr?.value && String(mt.hex) === String(ticket.qr.value)) return true;
      if (seatId && String(mt.seatId || '').trim().toLowerCase() === seatId.toLowerCase()) return true;
      return false;
    });
    ticketIndex = idx >= 0 ? idx + 1 : null;
  }

  const line = (() => {
    if (!lines.length) return null;
    if (seatId) {
      const direct = lines.find((ln) => String(ln?.seatId || '').trim().toLowerCase() === seatId.toLowerCase());
      if (direct) return direct;
    }
    if (zoneKey) {
      const sameZone = lines.find((ln) =>
        String(ln?.seatId || '').trim() === '' &&
        String(ln?.zoneKey || '').toUpperCase() === zoneKey
      );
      if (sameZone) return sameZone;
    }
    return lines.find((ln) =>
      String(ln?.zoneKey || '').toUpperCase() === zoneKey &&
      normalizeTariffCode(ln?.tariffCode) === normalizeTariffCode(ticket?.tariffCode || metaTicket?.tariff || '')
    ) || null;
  })();

  const holder = {
    firstName: ticket?.holder?.firstName || line?.holderFirstName || '',
    lastName: ticket?.holder?.lastName || line?.holderLastName || '',
    email: ticket?.holder?.email || order?.payerEmail || ''
  };

  if (typeof scannedTickets !== 'number') scannedTickets = ticket.scannedAt ? 1 : 0;
  if (typeof totalTickets !== 'number') totalTickets = ticket.scannedAt ? scannedTickets : 0;

  const tariffCode = normalizeTariffCode(ticket?.tariffCode || metaTicket?.tariff || line?.tariffCode || '');
  const location = seatId || (zoneKey ? `Zone ${zoneKey}` : '');

  let orderOut = null;
  if (order) {
    orderOut = {
      id: normalizeId(order._id),
      payerFirstName: order?.payerFirstName || '',
      payerLastName: order?.payerLastName || '',
      payerEmail: order?.payerEmail || '',
      eventSlug: order?.meta?.eventSlug || eventSlug || ''
    };
  } else if (orderId) {
    orderOut = {
      id: orderId,
      payerFirstName: '',
      payerLastName: '',
      payerEmail: '',
      eventSlug: eventSlug || ''
    };
  }

  const orderTicketsMap = orderTicketMap instanceof Map ? orderTicketMap : new Map();
  if (orderOut) {
    orderOut.totalTickets = typeof totalTickets === 'number' ? totalTickets : 0;
    orderOut.scannedTickets = typeof scannedTickets === 'number' ? scannedTickets : 0;
    orderOut.ticketIndex = ticketIndex;
    const orderTickets = [];
    const additionalDocs = orderTicketsMap.get(orderId);
    if (Array.isArray(additionalDocs) && additionalDocs.length) {
      additionalDocs.sort((a, b) => String(a.seatId || '').localeCompare(String(b.seatId || '')));
      additionalDocs.forEach((doc, idx) => {
        const docSeat = String(doc.seatId || '').trim();
        const docZone = docSeat.includes('-') ? docSeat.split('-')[0].toUpperCase() : '';
        orderTickets.push({
          ticketId: normalizeId(doc._id),
          seatId: docSeat,
          zoneKey: docZone,
          tariffCode: normalizeTariffCode(doc.tariffCode),
          index: idx + 1,
          isCurrent: normalizeId(doc._id) === normalizeId(ticket._id),
          scanned: !!doc.scannedAt
        });
      });
    } else {
      const sourceArray = Array.isArray(metaTickets) && metaTickets.length ? metaTickets : lines;
      sourceArray.forEach((item, idx) => {
        if (!item) return;
        const derivedId = normalizeId(item.ticketId || item._id);
        const seatVal = String(item.seatId || '').trim();
        orderTickets.push({
          ticketId: derivedId,
          seatId: seatVal,
          zoneKey: String(item.zoneKey || '').toUpperCase(),
          tariffCode: normalizeTariffCode(item.tariff || item.tariffCode),
          index: idx + 1,
          isCurrent: derivedId && normalizeId(ticket._id) === derivedId,
          scanned: derivedId === normalizeId(ticket._id) ? !!ticket.scannedAt : false
        });
      });
    }
    orderOut.tickets = orderTickets;
  }

  const history = Array.isArray(ticket.scanHistory)
    ? ticket.scanHistory.map((h) => ({
        when: h.when || ticket.scannedAt || ticket.updatedAt || ticket.createdAt,
        action: h.action || 'accept',
        by: h.by || ''
      })).sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0))
    : [];

  const lookupMap = tariffLookup instanceof Map ? tariffLookup : null;
  const fallbackTariffLabel = String(
    line?.tariffLabel ||
    line?.tariffName ||
    metaTicket?.tariffLabel ||
    metaTicket?.tariffName ||
    ''
  ).trim();
  const rawTariff = lookupMap && tariffCode ? lookupMap.get(tariffCode) : null;
  const resolvedLabel = String(rawTariff?.label || fallbackTariffLabel || '').trim() || tariffCode;
  const resolvedFieldLabel = String(rawTariff?.fieldLabel || metaTicket?.fieldLabel || '').trim();
  const resolvedInfo = String(rawTariff?.requiresInfo || metaTicket?.requiresInfo || '').trim();
  let resolvedRequiresField = rawTariff?.requiresField ?? metaTicket?.requiresField ?? null;
  if (typeof resolvedRequiresField === 'string') {
    resolvedRequiresField = resolvedRequiresField.trim();
    if (resolvedRequiresField === '') resolvedRequiresField = null;
  }

  const tariffInfo = {
    code: tariffCode,
    label: resolvedLabel,
    requiresField: resolvedRequiresField ?? null,
    fieldLabel: resolvedFieldLabel,
    requiresInfo: resolvedInfo
  };

  return {
    ticketId: normalizeId(ticket._id),
    qrValue: ticket?.qr?.value || '',
    status,
    seatId,
    zoneKey,
    location,
    tariffCode,
    tariffLabel: tariffInfo.label,
    tariffFieldLabel: tariffInfo.fieldLabel,
    tariffRequiresField: tariffInfo.requiresField,
    tariffRequiresInfo: tariffInfo.requiresInfo,
    tariff: tariffInfo,
    holder,
    scannedAt: ticket.scannedAt || null,
    scannedBy: ticket.scannedBy || null,
    scanCount: ticket.scanCount || 0,
    scanHistory: history,
    order: orderOut,
    conditions: buildConditions(line, metaTicket),
    isPrimary
  };
}

async function fetchMatches(lookupValues, resolvedEvent) {
  const docs = await Ticket.find({ 'qr.value': { $in: lookupValues } }).lean();
  const seen = new Set();
  const tickets = [];

  for (const doc of docs) {
    const id = normalizeId(doc?._id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tickets.push(doc);
  }

  if (!tickets.length) {
    return {
      matches: [],
      orderMap: new Map(),
      orderStats: new Map(),
      orderTicketDocsByOrder: new Map(),
      tariffLookup: new Map()
    };
  }

  const canonicalId = normalizeId(resolvedEvent?.id);
  const slug = String(resolvedEvent?.slug || '').toLowerCase();
  const eventDoc = resolvedEvent?.doc || null;

  const tariffCodes = new Set();
  const addTariffCode = (value) => {
    const code = normalizeTariffCode(value);
    if (code) tariffCodes.add(code);
  };

  tickets.forEach((ticket) => addTariffCode(ticket?.tariffCode));

  const orderIds = tickets
    .map((t) => normalizeId(t.orderId))
    .filter(Boolean);

  const uniqueOrderIds = Array.from(new Set(orderIds));

  const orders = uniqueOrderIds.length
    ? await Order.find(
        { _id: { $in: uniqueOrderIds } },
        {
          payerFirstName: 1,
          payerLastName: 1,
          payerEmail: 1,
          lines: 1,
          meta: 1
        }
      ).lean()
    : [];

  const orderMap = new Map(orders.map((ord) => [normalizeId(ord._id), ord]));
  const orderStats = new Map();

  for (const ord of orders) {
    for (const ln of ord?.lines || []) {
      addTariffCode(ln?.tariffCode);
    }
    if (Array.isArray(ord?.meta?.tickets)) {
      ord.meta.tickets.forEach((mt) => addTariffCode(mt?.tariff || mt?.tariffCode));
    }
  }

  let orderTicketDocsByOrder = new Map();

  if (uniqueOrderIds.length) {
    const statsDocs = await Ticket.find(
      { orderId: { $in: uniqueOrderIds }, eventId: { $in: [canonicalId, resolvedEvent?.slug].filter(Boolean) } },
      { orderId: 1, scannedAt: 1 }
    ).lean();
    for (const doc of statsDocs) {
      const key = normalizeId(doc.orderId);
      if (!key) continue;
      if (!orderStats.has(key)) orderStats.set(key, { total: 0, scanned: 0 });
      const stats = orderStats.get(key);
      stats.total += 1;
      if (doc.scannedAt) stats.scanned += 1;
    }
    for (const orderId of uniqueOrderIds) {
      if (orderStats.has(orderId)) continue;
      const ord = orderMap.get(orderId);
      if (ord?.meta?.tickets?.length) {
        orderStats.set(orderId, { total: ord.meta.tickets.length, scanned: 0 });
      } else if (ord?.lines?.length) {
        orderStats.set(orderId, { total: ord.lines.length, scanned: 0 });
      } else {
        orderStats.set(orderId, { total: 0, scanned: 0 });
      }
    }
    const orderTicketDocs = await Ticket.find({ orderId: { $in: uniqueOrderIds } }).lean();
    for (const doc of orderTicketDocs) {
      const key = normalizeId(doc.orderId);
      if (!key) continue;
      if (!orderTicketDocsByOrder.has(key)) orderTicketDocsByOrder.set(key, []);
      orderTicketDocsByOrder.get(key).push(doc);
      addTariffCode(doc?.tariffCode);
    }
  }

  let tariffLookup = new Map();
  if (tariffCodes.size) {
    const codes = Array.from(tariffCodes);
    const selectFields = {
      code: 1,
      label: 1,
      requiresField: 1,
      fieldLabel: 1,
      requiresInfo: 1,
      priceTableKey: 1
    };

    let tariffDocs = [];
    if (eventDoc?.priceTableKey) {
      tariffDocs = await Tariff.find(
        { priceTableKey: eventDoc.priceTableKey, code: { $in: codes } },
        selectFields
      ).lean();
    }

    const missingCodes = new Set(
      codes.filter((code) => !tariffDocs.some((doc) => normalizeTariffCode(doc?.code) === code))
    );

    if (missingCodes.size) {
      const fallbackDocs = await Tariff.find(
        { priceTableKey: null, code: { $in: Array.from(missingCodes) } },
        selectFields
      ).lean();
      tariffDocs = [...tariffDocs, ...fallbackDocs];
    }

    tariffLookup = buildTariffLookupMap(tariffDocs, eventDoc);
  }

  const matches = tickets
    .map((ticket) =>
      composeMatch(
        ticket,
        orderMap.get(normalizeId(ticket.orderId)),
        canonicalId,
        slug,
        {
          orderStats,
          orderTicketMap: orderTicketDocsByOrder,
          isPrimary: true,
          tariffLookup
        }
      )
    )
    .filter(Boolean);

  const matchById = new Map(matches.map((m) => [normalizeId(m.ticketId), m]));

  for (const [orderId, docs] of orderTicketDocsByOrder.entries()) {
    for (const doc of docs) {
      const docId = normalizeId(doc._id);
      if (!docId || matchById.has(docId)) continue;
      const extra = composeMatch(
        doc,
        orderMap.get(orderId),
        canonicalId,
        slug,
        {
          orderStats,
          orderTicketMap: orderTicketDocsByOrder,
          isPrimary: false,
          tariffLookup
        }
      );
      if (extra) {
        matches.push(extra);
        matchById.set(docId, extra);
      }
    }
  }

  return { matches, orderMap, orderStats, orderTicketDocsByOrder, tariffLookup };
}
/**
 * POST /api/scan
 * Body: { value: "qr|sig", eventId, deviceId, decision?, ticketId?, force? }
 */

router.post('/api/scan', requireScanner, async (req, res) => {
  const now = new Date();
  const {
    value: raw,
    eventId: eventInput,
    deviceId,
    decision = 'preview',
    ticketId,
    force
  } = req.body || {};

  if (!raw || !eventInput) {
    return res.status(400).json({ ok: false, error: 'missing_params' });
  }

  let eventResolved;
  try {
    eventResolved = await resolveEventKey(eventInput);
  } catch (err) {
    if (err?.code === 'EVENT_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'event_not_found' });
    }
    if (err?.code === 'EVENT_REQUIRED') {
      return res.status(400).json({ ok: false, error: 'event_required' });
    }
    throw err;
  }

  const canonicalEventId = eventResolved.id;
  const eventPayload = { id: canonicalEventId, slug: eventResolved.slug || null };

  const lookupSet = extractLookupVariants(raw);
  if (process.env.QR_SECRET) {
    const { ok, value: unsignedValue, reason } = verifySignature(raw);
    if (!ok && reason !== 'no_sig') {
      await ScanLog.create({
        when: now,
        eventId: canonicalEventId,
        qrValue: raw,
        ok: false,
        reason: 'bad_sig',
        deviceId,
        gate: req.headers['x-gate'] || process.env.SCAN_GATE_NAME || deviceId || ''
      });
      return res.json({ ok: false, reason: 'invalid_signature', event: eventPayload });
    }
    if (ok) {
      for (const variant of extractLookupVariants(unsignedValue)) {
        lookupSet.add(variant);
      }
    }
  }

  const lookupValues = Array.from(lookupSet);
  if (!lookupValues.length) {
    lookupValues.push(String(raw));
  }

  const gateName = req.headers['x-gate'] || process.env.SCAN_GATE_NAME || deviceId || '';
  const { matches, tariffLookup } = await fetchMatches(lookupValues, eventResolved);
  const normalizedTicketId = normalizeId(ticketId);
  const findMatchById = (list, id) => {
    if (!id) return null;
    return list.find((m) => normalizeId(m.ticketId) === id) || null;
  };

  if (decision === 'preview') {
    if (!matches.length) {
      await ScanLog.create({
        when: now,
        eventId: canonicalEventId,
        qrValue: raw,
        ok: false,
        reason: 'unknown_qr',
        deviceId,
        gate: gateName
      });
      return res.json({ ok: false, matches: [], reason: 'unknown_qr', qrValue: raw, event: eventPayload });
    }
    return res.json({
      ok: matches.some((m) => m.status === 'ready'),
      matches,
      qrValue: raw,
      event: eventPayload
    });
  }

  if (decision === 'reject') {
    const match = findMatchById(matches, normalizedTicketId);
    await ScanLog.create({
      when: now,
      eventId: canonicalEventId,
      ticketId: match?.ticketId,
      qrValue: raw,
      ok: false,
      reason: 'rejected',
      deviceId,
      gate: gateName
    });
    return res.json({ ok: true, decision: 'reject', match, event: eventPayload });
  }

  if (decision === 'auto') {
    if (!matches.length) {
      await ScanLog.create({
        when: now,
        eventId: canonicalEventId,
        qrValue: raw,
        ok: false,
        reason: 'unknown_qr',
        deviceId,
        gate: gateName
      });
      return res.json({ ok: false, reason: 'unknown_qr', event: eventPayload });
    }

    const match = matches.find((m) => m.status === 'ready') || matches[0];
    if (!match) {
      return res.json({ ok: false, reason: 'unknown_qr', event: eventPayload });
    }

    if (match.status === 'wrong_event') {
      await ScanLog.create({
        when: now,
        eventId: canonicalEventId,
        ticketId: match.ticketId,
        qrValue: raw,
        ok: false,
        reason: 'event_mismatch',
        deviceId,
        gate: gateName
      });
      return res.json({ ok: false, reason: 'wrong_event', match, event: eventPayload });
    }

    if (match.status === 'already_scanned' && !force) {
      await ScanLog.create({
        when: now,
        eventId: canonicalEventId,
        ticketId: match.ticketId,
        qrValue: raw,
        ok: false,
        reason: 'already_scanned',
        deviceId,
        gate: gateName
      });
      return res.json({ ok: false, reason: 'already_scanned', match, event: eventPayload });
    }

    const updated = await Ticket.findByIdAndUpdate(
      match.ticketId,
      {
        $set: {
          scannedAt: now,
          scannedBy: gateName
        },
        $inc: { scanCount: 1 },
        $push: {
          scanHistory: {
            when: now,
            by: gateName,
            action: 'auto'
          }
        }
      },
      { new: true }
    );

    await ScanLog.create({
      when: now,
      eventId: canonicalEventId,
      ticketId: match.ticketId,
      qrValue: raw,
      ok: true,
      reason: 'auto_accept',
      deviceId,
      gate: gateName
    });

    const orderDoc = updated?.orderId ? await Order.findById(updated.orderId).lean() : null;
    const refreshed = composeMatch(updated, orderDoc, canonicalEventId, eventResolved.slug, { tariffLookup });

    return res.json({ ok: true, decision: 'accept', ticket: refreshed, event: eventPayload });
  }

  if (decision === 'confirm') {
    let match = findMatchById(matches, normalizedTicketId);
    const reason = match
      ? (match.status === 'already_scanned' ? 'confirmed_already_scanned'
        : match.status === 'wrong_event' ? 'confirmed_wrong_event'
        : 'confirmed_ticket')
      : 'confirmed_unknown_qr';

    await ScanLog.create({
      when: now,
      eventId: canonicalEventId,
      ticketId: match?.ticketId,
      qrValue: raw,
      ok: false,
      reason,
      deviceId,
      gate: gateName
    });

    return res.json({ ok: true, decision: 'confirm', match, qrValue: raw, event: eventPayload });
  }

  if (decision === 'accept') {
    if (!ticketId) {
      return res.status(400).json({ ok: false, error: 'ticket_required' });
    }

    const ticket = await Ticket.findById(ticketId);
    if (!ticket) {
      await ScanLog.create({
        when: now,
        eventId: canonicalEventId,
        ticketId,
        qrValue: raw,
        ok: false,
        reason: 'unknown_ticket',
        deviceId,
        gate: gateName
      });
      return res.json({ ok: false, reason: 'unknown_ticket', event: eventPayload });
    }

    const valuesSet = new Set(lookupValues.map(String));
    if (!valuesSet.has(String(ticket.qr?.value || ''))) {
      return res.json({ ok: false, reason: 'mismatch_qr', event: eventPayload });
    }

    if (normalizeId(ticket.eventId) !== canonicalEventId && String(ticket.eventId || '').toLowerCase() !== String(eventResolved.slug || '').toLowerCase()) {
      await ScanLog.create({
        when: now,
        eventId: canonicalEventId,
        ticketId,
        qrValue: raw,
        ok: false,
        reason: 'event_mismatch',
        deviceId,
        gate: gateName
      });
      return res.json({ ok: false, reason: 'wrong_event', event: eventPayload });
    }

    if (ticket.scannedAt && !force) {
      const orderDoc = ticket?.orderId ? await Order.findById(ticket.orderId).lean() : null;
      await ScanLog.create({
        when: now,
        eventId: canonicalEventId,
        ticketId,
        qrValue: raw,
        ok: false,
        reason: 'already_scanned',
        deviceId,
        gate: gateName
      });
      return res.json({
        ok: false,
        reason: 'already_scanned',
        ticket: composeMatch(ticket, orderDoc, canonicalEventId, eventResolved.slug, { tariffLookup }),
        event: eventPayload
      });
    }

    const updated = await Ticket.findByIdAndUpdate(
      ticketId,
      {
        $set: {
          scannedAt: now,
          scannedBy: gateName
        },
        $inc: { scanCount: 1 },
        $push: {
          scanHistory: {
            when: now,
            by: gateName,
            action: force ? 'force' : 'accept'
          }
        }
      },
      { new: true }
    );

    await ScanLog.create({
      when: now,
      eventId: canonicalEventId,
      ticketId,
      qrValue: raw,
      ok: true,
      reason: force ? 'forced_accept' : 'accepted',
      deviceId,
      gate: gateName
    });

    const orderDoc = updated?.orderId ? await Order.findById(updated.orderId).lean() : null;
    const refreshed = composeMatch(updated, orderDoc, canonicalEventId, eventResolved.slug, { tariffLookup });

    return res.json({ ok: true, decision: 'accept', ticket: refreshed, event: eventPayload });
  }

  if (decision === 'exit') {
    if (!ticketId) {
      return res.status(400).json({ ok: false, error: 'ticket_required' });
    }

    const ticket = await Ticket.findById(ticketId);
    if (!ticket) {
      return res.json({ ok: false, reason: 'unknown_ticket', event: eventPayload });
    }

    const valuesSet = new Set(lookupValues.map(String));
    if (!valuesSet.has(String(ticket.qr?.value || ''))) {
      return res.json({ ok: false, reason: 'mismatch_qr', event: eventPayload });
    }

    if (ticket.scanCount && ticket.scanCount > 0) {
      ticket.scanCount = Math.max(0, Number(ticket.scanCount) - 1);
    }
    ticket.scannedAt = null;
    ticket.scannedBy = gateName;
    if (!Array.isArray(ticket.scanHistory)) ticket.scanHistory = [];
    ticket.scanHistory.push({ when: now, by: gateName, action: 'exit' });
    await ticket.save();

    await ScanLog.create({
      when: now,
      eventId: canonicalEventId,
      ticketId,
      qrValue: raw,
      ok: true,
      reason: 'exit',
      deviceId,
      gate: gateName
    });

    const orderDoc = ticket?.orderId ? await Order.findById(ticket.orderId).lean() : null;
    const refreshed = composeMatch(ticket, orderDoc, canonicalEventId, eventResolved.slug, { tariffLookup });

    return res.json({ ok: true, decision: 'exit', ticket: refreshed, event: eventPayload });
  }

  return res.status(400).json({ ok: false, error: 'invalid_decision' });
});

// ---------- PWA (view + manifest + service worker) ----------

// GET /scan (view)
function renderScanView(_req, res) {
  const bp = basePath();
  const scope = `${bp}/scan/`.replace(/\/{2,}/g, '/');
  const assetBase = `${bp}/static/`.replace(/\/{2,}/g, '/');
  res.render('scan/index', {
    title: 'Contrôle d’accès — BTS',
    basePath: bp,
    scope,
    assetBase
  });
}
router.get('/scan/events.json', async (req, res) => {
  try {
    const season = String(req.query.season || '').trim();
    const limitRaw = Number(req.query.limit || 200);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 200;
    const filter = {};
    if (season) filter.seasonCode = season;

    const docs = await Event.find(filter, {
      _id: 1,
      slug: 1,
      name: 1,
      startsAt: 1,
      seasonCode: 1,
      venueSlug: 1,
      isOnSale: 1
    })
      .sort({ startsAt: 1 })
      .limit(limit)
      .lean();

    const events = docs.map((doc) => ({
      id: String(doc._id),
      slug: doc.slug || '',
      name: doc.name || doc.slug || '',
      startsAt: doc.startsAt || null,
      seasonCode: doc.seasonCode || null,
      venueSlug: doc.venueSlug || null,
      isOnSale: doc.isOnSale === true
    }));

    res.json({ ok: true, events });
  } catch (err) {
    req.log?.error?.({ err }, 'scan_events_list_failed');
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.get('/scan/qr.svg', async (req, res) => {
  const rawValue = String(req.query.value ?? '').trim();
  if (!rawValue) {
    return res.status(400).type('text/plain').send('value_required');
  }
  if (rawValue.length > 256) {
    return res.status(400).type('text/plain').send('value_too_long');
  }

  try {
    const svg = await renderQrSvg({ text: rawValue, size: 160 });
    res.set('Cache-Control', 'no-store, max-age=0');
    res.type('image/svg+xml; charset=utf-8').send(svg);
  } catch (err) {
    req.log?.error?.({ err }, 'qr_svg_render_failed');
    res.status(500).type('text/plain').send('qr_render_failed');
  }
});

router.get(['/scan', '/scan/:eventSlug([\w-]+)'], renderScanView);

// GET /bts/scan/manifest.webmanifest
router.get('/scan/manifest.webmanifest', (req,res) => {
  const bp = basePath();
  const scope = `${bp}/scan/`.replace(/\/{2,}/g, '/');
  const manifest = {
    name: 'BTS Contrôle',
    short_name: 'BTS Scan',
    start_url: `${scope}?source=pwa`,
    scope,
    display: 'standalone',
    background_color: '#0b0f17',
    theme_color: '#0b0f17',
    icons: [
      { src: 'static/img/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: 'static/img/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  };
  res.type('application/manifest+json').send(JSON.stringify(manifest));
});

// GET /bts/scan/sw.js (service worker)
router.get('/scan/sw.js', (req,res) => {
  res.type('text/javascript').send(`
// BTS Scan Service Worker
const VERSION = 'v1.0.1';
self.addEventListener('install', (e)=>{
  e.waitUntil((async()=>{
    const c = await caches.open('bts-scan-shell-'+VERSION);
    // Cache léger: on laisse la page charger ses assets; offline ≈ manifest/JS/CSS via HTTP cache
    await c.addAll([self.registration.scope, self.registration.scope + 'manifest.webmanifest']);
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e)=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=>k.startsWith('bts-scan-shell-') && !k.endsWith(VERSION)).map(k=>caches.delete(k)));
    self.clients.claim();
  })());
});
// Network-first pour éviter de cacher la page active
self.addEventListener('fetch', (event)=>{
  const url = new URL(event.request.url);
  // on ne s'occupe que du scope PWA
  if (!url.href.startsWith(self.registration.scope)) return;
  if (event.request.method !== 'GET') return;
  event.respondWith((async()=>{
    try {
      return await fetch(event.request);
    } catch {
      const cache = await caches.open('bts-scan-shell-'+VERSION);
      const cached = await cache.match(event.request);
      return cached || new Response('Offline', { status: 503 });
    }
  })());
});
// Background sync minimal (optionnel)
self.addEventListener('message', async (event)=>{
  // future hook: flush queue via postMessage si besoin
});
  `);
});

export default router;
