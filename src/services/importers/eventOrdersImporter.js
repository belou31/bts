import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import mongoose from 'mongoose';

import { Event } from '../../models/Event.js';
import { Order } from '../../models/Order.js';
import { Seat } from '../../models/Seat.js';
import { sendOrderAttestationIfNeeded, isPaidLike, ensureTicketsForEventOrder } from '../order-finalization.js';
import { currentPaymentProviderLabel } from '../payments/index.js';

const ALLOWED_STATUS = new Set([
  'pending',
  'paid',
  'failed',
  'canceled',
  'authorized',
  'processed'
]);

function ensureLogger(logger) {
  if (logger && typeof logger.info === 'function') return logger;
  return console;
}

function stripBOM(input = '') {
  return String(input).replace(/^\uFEFF/, '');
}

function detectSeparator(headerLine, forced) {
  if (forced) return forced;
  const counts = (char) => (headerLine.match(new RegExp(`\\${char}`, 'g')) || []).length;
  const semi = counts(';');
  const comma = counts(',');
  return semi > comma ? ';' : ',';
}

function splitCsvLine(line, separator) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === separator && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.map((value) => value.trim());
}

function parseCSVDate(value) {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function maybeObjectId(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(str)) return null;
  try {
    return new mongoose.Types.ObjectId(str);
  } catch {
    return null;
  }
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parsePrice(row) {
  let cents = toNumber(row.priceCents, NaN);
  if (!Number.isFinite(cents) || cents <= 0) {
    const euro = row.priceEuro ?? row.price ?? null;
    if (euro !== null && euro !== undefined && euro !== '') {
      const euroNum = Number(euro);
      if (Number.isFinite(euroNum)) cents = Math.round(euroNum * 100);
    }
  }
  if (!Number.isFinite(cents) || cents < 0) return 0;
  return cents;
}

function normalizeStatus(raw, override) {
  const base = override || raw;
  const s = String(base || 'paid').trim().toLowerCase();
  if (!s) return 'paid';
  if (ALLOWED_STATUS.has(s)) return s;
  if (/^(success|succeeded|ok)$/i.test(s)) return 'paid';
  if (/^(authorised|authorized_ok)$/i.test(s)) return 'authorized';
  return ALLOWED_STATUS.has(override || '') ? override : 'paid';
}

function deriveGroupKey(firstRow, fallbackId, eventOverride) {
  return (
    firstRow.groupKey?.trim() ||
    firstRow.orderRef?.trim() ||
    firstRow.group?.trim() ||
    firstRow.orderGroup?.trim() ||
    (firstRow.payerEmail
      ? `${String(firstRow.payerEmail).toLowerCase().trim()}#${
          firstRow.eventSlug || firstRow.eventId || eventOverride || 'event'
        }`
      : '') ||
    fallbackId
  );
}

function buildHeaderIndex(headerCells) {
  const lookup = new Map();
  headerCells.forEach((raw, columnIndex) => {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) return;
    lookup.set(key, columnIndex);
  });
  return (aliases) => {
    for (const alias of aliases) {
      const idx = lookup.get(String(alias || '').toLowerCase());
      if (idx != null) return idx;
    }
    return -1;
  };
}

function sanitizeLines(rows) {
  const lines = [];
  let fallbackIndex = 0;
  const seenSeats = new Set();

  for (const row of rows) {
    const seatRaw = String(row.seatId || '').trim();
    const zoneRaw = String(row.zoneKey || '').trim();
    const tariffRaw = String(row.tariffCode || '').trim();
    if (!zoneRaw && !seatRaw) {
      throw new Error('zoneKey ou seatId requis pour chaque ligne');
    }

    const quantity = Math.max(1, toNumber(row.quantity || 1, 1));
    if (quantity > 1 && seatRaw) {
      throw new Error(
        `Impossible de dupliquer la ligne avec seatId=${seatRaw} (quantity=${quantity}). Dupliquez la ligne dans le CSV.`
      );
    }

    const baseIndex = toNumber(row.lineIndex, fallbackIndex);
    const priceCents = parsePrice(row);

    const seatKey = seatRaw ? seatRaw.toUpperCase() : '';
    if (seatKey) {
      if (seenSeats.has(seatKey)) {
        throw new Error(`Seat ${seatRaw} apparaît plusieurs fois dans le groupe`);
      }
      seenSeats.add(seatKey);
    }

    for (let i = 0; i < quantity; i++) {
      lines.push({
        lineIndex: quantity === 1 ? baseIndex : baseIndex + i,
        seatId: quantity === 1 ? seatRaw : '',
        zoneKey: zoneRaw.toUpperCase(),
        tariffCode: tariffRaw.toUpperCase() || 'NORMAL',
        priceCents,
        holderFirstName: row.holderFirstName || '',
        holderLastName: row.holderLastName || ''
      });
      fallbackIndex += 1;
    }
  }

  if (!lines.length) throw new Error('Aucune ligne de billet pour cette commande');
  return lines.sort((a, b) => a.lineIndex - b.lineIndex);
}

function collectSeatIds(lines) {
  return Array.from(
    new Set(
      lines
        .map((l) => String(l.seatId || '').trim())
        .filter(Boolean)
    )
  );
}

async function resolveEvent({ eventId, eventSlug, eventOverride }, cache) {
  const candidates = [];
  const idTrim = eventId ? String(eventId).trim() : '';
  const slugTrim = eventSlug ? String(eventSlug).trim() : '';
  const override = eventOverride ? String(eventOverride).trim() : '';

  if (idTrim) candidates.push({ kind: 'id', value: idTrim });
  if (slugTrim) candidates.push({ kind: 'slug', value: slugTrim });
  if (override) {
    const isId = mongoose.Types.ObjectId.isValid(override);
    candidates.push({ kind: isId ? 'id' : 'slug', value: override });
  }

  if (!candidates.length) {
    throw new Error('eventId/eventSlug manquant');
  }

  for (const cand of candidates) {
    const cacheKey = `${cand.kind}:${cand.value}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
  }

  let ev = null;
  for (const cand of candidates) {
    try {
      if (cand.kind === 'id') {
        if (mongoose.Types.ObjectId.isValid(cand.value)) {
          ev = await Event.findById(cand.value).lean();
        }
        if (!ev) {
          ev = await Event.findOne({
            $or: [{ _id: cand.value }, { slug: cand.value }]
          }).lean();
        }
      } else {
        ev = await Event.findOne({ slug: cand.value }).lean();
      }
      if (ev) break;
    } catch {
      // continue to next candidate
    }
  }

  if (!ev) {
    throw new Error(
      `Événement introuvable (candidats: ${candidates
        .map((c) => `${c.kind}=${c.value}`)
        .join(', ')})`
    );
  }

  cache.set(`id:${ev._id}`, ev);
  cache.set(`slug:${ev.slug}`, ev);
  return ev;
}

function buildOrderDoc(parsed, existing) {
  const {
    event,
    seasonCode,
    venueSlug,
    groupKey,
    payerFirstName,
    payerLastName,
    payerEmail,
    paymentSplit,
    totalCents,
    status,
    lines,
    providerName,
    meta,
    createdAt,
    itemName
  } = parsed;

  const mergedMeta = { ...(existing?.meta || {}) };
  mergedMeta.eventId = String(event._id);
  mergedMeta.eventSlug = event.slug;
  if (meta.eventName || event.name) mergedMeta.eventName = meta.eventName || event.name;
  if (meta.eventStartsAt || event.startsAt) {
    mergedMeta.eventStartsAt = meta.eventStartsAt
      ? new Date(meta.eventStartsAt)
      : event.startsAt;
  }
  if (meta.eventNotes) mergedMeta.eventNotes = meta.eventNotes;

  const paymentMeta = { ...(existing?.paymentProviderMeta || {}) };
  paymentMeta.importedAt = new Date();
  paymentMeta.source = 'import-event-orders';
  paymentMeta.eventId = String(event._id);
  paymentMeta.eventSlug = event.slug;
  if (meta.haOrderId) paymentMeta.haOrderId = meta.haOrderId;
  if (meta.checkoutIntentId) paymentMeta.checkoutIntentId = meta.checkoutIntentId;
  if (meta.lastReturnCode) paymentMeta.lastReturnCode = meta.lastReturnCode;
  if (meta.lastWebhookEvent) paymentMeta.lastWebhookEvent = meta.lastWebhookEvent;
  if (meta.attestationSentAt) paymentMeta.attestationSentAt = meta.attestationSentAt;

  const doc = {
    seasonCode,
    venueSlug,
    phase: 'event',
    itemName: itemName || existing?.itemName || `EVENT_${event.slug}`,
    groupKey: groupKey || existing?.groupKey || `EVENT-${event.slug}`,
    payerFirstName: payerFirstName || '',
    payerLastName: payerLastName || '',
    payerEmail: payerEmail || '',
    paymentSplit: paymentSplit || 1,
    totalCents,
    status,
    paymentProvider: providerName || existing?.paymentProvider || 'import',
    paymentProviderMeta: paymentMeta,
    origin: { flow: 'event', uiPath: '/event', apiPath: '/admin/import/event-orders' },
    mailTemplateKind: 'event',
    meta: mergedMeta,
    lines: lines.map((l) => ({
      seatId: l.seatId,
      zoneKey: l.zoneKey,
      tariffCode: l.tariffCode,
      priceCents: l.priceCents,
      holderFirstName: l.holderFirstName || '',
      holderLastName: l.holderLastName || ''
    })),
    createdAt,
    updatedAt: createdAt
  };

  if (meta.paymentSplit && !Number.isNaN(Number(meta.paymentSplit))) {
    doc.paymentSplit = Number(meta.paymentSplit);
  }

  if (!doc.totalCents) {
    doc.totalCents = doc.lines.reduce(
      (acc, line) => acc + (Number(line.priceCents) || 0),
      0
    );
  }

  return doc;
}

async function detectSeatConflicts(parsed, seatIds, existingId) {
  if (!seatIds.length) return [];

  const conflicts = [];
  const seasonCode = parsed.seasonCode;
  const venueSlug = parsed.venueSlug;

  const seats = await Seat.find({
    seasonCode,
    venueSlug,
    seatId: { $in: seatIds }
  }).lean();
  const knownSeats = new Set(seats.map((s) => String(s.seatId)));

  for (const sid of seatIds) {
    if (!knownSeats.has(sid)) {
      conflicts.push({ seatId: sid, reason: 'seat_not_found' });
    }
  }

  const dupes = seatIds.filter((sid, idx) => seatIds.indexOf(sid) !== idx);
  if (dupes.length) {
    for (const sid of new Set(dupes)) {
      conflicts.push({ seatId: sid, reason: 'duplicate_in_csv' });
    }
  }

  const orderConflicts = await Order.find(
    {
      'meta.eventId': String(parsed.event._id),
      status: { $in: ['paid', 'pending', 'processed', 'authorized'] },
      ...(existingId ? { _id: { $ne: existingId } } : {}),
      'lines.seatId': { $in: seatIds }
    },
    { _id: 1, status: 1, payerEmail: 1, lines: 1 }
  ).lean();

  for (const ord of orderConflicts) {
    for (const line of ord.lines || []) {
      const sid = String(line.seatId || '').trim();
      if (!sid || !seatIds.includes(sid)) continue;
      conflicts.push({
        seatId: sid,
        reason: 'already_booked',
        orderId: String(ord._id),
        status: ord.status,
        payerEmail: ord.payerEmail || ''
      });
    }
  }

  return conflicts;
}

async function loadCsvGroups(csvPath, { rootDir, inputsDir, separator, eventOverride }) {
  const candidates = [];
  if (path.isAbsolute(csvPath)) {
    candidates.push(csvPath);
  } else {
    candidates.push(path.resolve(rootDir, csvPath));
    candidates.push(path.resolve(inputsDir, csvPath));
  }

  const existingPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!existingPath) {
    throw new Error(
      `CSV introuvable: ${csvPath} (cherché: ${candidates.join(', ')})`
    );
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(existingPath, 'utf8'),
    crlfDelay: Infinity
  });

  let headerParsed = false;
  let header = [];
  let getIdx = null;
  let detectedSeparator = ',';
  const groups = new Map();
  let auto = 0;

  for await (const raw of rl) {
    const line = stripBOM(String(raw || '').trim());
    if (!line) continue;

    if (!headerParsed) {
      detectedSeparator = detectSeparator(line, separator);
      header = splitCsvLine(line, detectedSeparator).map((c) => c.trim());
      getIdx = buildHeaderIndex(header);
      headerParsed = true;
      continue;
    }

    const cols = splitCsvLine(line, detectedSeparator);
    const row = {};
    for (let i = 0; i < header.length; i += 1) {
      if (!header[i]) continue;
      row[header[i]] = cols[i] ?? '';
    }

    const orderId = (row.orderId || '').trim();
    let groupKey = orderId || row.orderRef?.trim() || row.groupKey?.trim();
    if (!groupKey) {
      auto += 1;
      const email = row.payerEmail
        ? String(row.payerEmail).trim().toLowerCase()
        : `row-${auto}`;
      const evRef =
        row.eventSlug?.trim() || row.eventId?.trim() || String(eventOverride || 'event');
      groupKey = `${email}::${evRef}::${auto}`;
    }

    if (!groups.has(groupKey)) {
      groups.set(groupKey, { key: groupKey, orderId: orderId || null, rows: [] });
    }

    const pack = groups.get(groupKey);
    if (!pack.orderId && orderId) pack.orderId = orderId;
    pack.rows.push(row);
  }

  return groups;
}

async function orderFromGroup(key, pack, options) {
  const { statusOverride, eventOverride, eventCache } = options;
  const rows = pack.rows;
  if (!rows.length) throw new Error(`Groupe ${key} vide`);
  const first = rows[0];

  const event = await resolveEvent(
    {
      eventId: first.eventId,
      eventSlug: first.eventSlug,
      eventOverride
    },
    eventCache
  );

  const lines = sanitizeLines(rows);
  const status = normalizeStatus(first.status, statusOverride);
  const createdAt = parseCSVDate(first.createdAt) || new Date();
  const paymentSplit = toNumber(first.paymentSplit || 1, 1);
  const totalCentsRaw = toNumber(first.totalCents || 0, 0);
  const totalCents =
    lines.reduce((acc, l) => acc + (Number(l.priceCents) || 0), 0) || totalCentsRaw;
  const groupKey = deriveGroupKey(first, pack.orderId || key, eventOverride);

  const meta = {
    haOrderId: first.haOrderId || '',
    checkoutIntentId: first.checkoutIntentId || '',
    lastReturnCode: first.lastReturnCode || '',
    lastWebhookEvent: first.lastWebhookEvent || '',
    attestationSentAt: parseCSVDate(first.attestationSentAt),
    eventName: first.eventName || '',
    eventStartsAt: parseCSVDate(first.eventStartsAt),
    paymentSplit: first.paymentSplit,
    eventNotes: first.eventNotes || ''
  };

  return {
    key,
    event,
    orderIdRaw: pack.orderId,
    objectId: maybeObjectId(pack.orderId),
    seasonCode: first.seasonCode || event.seasonCode,
    venueSlug: first.venueSlug || event.venueSlug,
    payerFirstName: first.payerFirstName || '',
    payerLastName: first.payerLastName || '',
    payerEmail: first.payerEmail || '',
    paymentSplit,
    totalCents,
    status,
    lines,
    meta,
    createdAt,
    groupKey,
    providerName: first.providerName || first.paymentProvider || 'import',
    itemName: first.itemName || ''
  };
}

async function normalizeInlineOrder(inline, options) {
  const {
    statusOverride,
    eventOverride,
    eventCache
  } = options;

  const event = await resolveEvent(
    {
      eventId: inline.eventId,
      eventSlug: inline.eventSlug,
      eventOverride
    },
    eventCache
  );

  const baseLines = Array.isArray(inline.lines) ? inline.lines : [];
  if (!baseLines.length) {
    throw new Error('Aucune ligne fournie pour cette commande');
  }

  const rows = baseLines.map((line, index) => ({
    lineIndex: line.lineIndex ?? index,
    seatId: line.seatId || '',
    zoneKey: line.zoneKey || line.zone || '',
    tariffCode: line.tariffCode || line.tariff || '',
    priceCents: line.priceCents ?? line.price ?? '',
    holderFirstName: line.holderFirstName || '',
    holderLastName: line.holderLastName || '',
    quantity: line.quantity ?? 1
  }));

  const lines = sanitizeLines(rows);
  const status = normalizeStatus(inline.status, statusOverride);
  const createdAt = parseCSVDate(inline.createdAt) || new Date();
  const paymentSplit = toNumber(inline.paymentSplit || 1, 1);
  const totalCents =
    inline.totalCents ??
    lines.reduce((acc, l) => acc + (Number(l.priceCents) || 0), 0);

  const meta = {
    haOrderId: inline.haOrderId || '',
    checkoutIntentId: inline.checkoutIntentId || '',
    lastReturnCode: inline.lastReturnCode || '',
    lastWebhookEvent: inline.lastWebhookEvent || '',
    attestationSentAt: parseCSVDate(inline.attestationSentAt),
    eventName: inline.eventName || '',
    eventStartsAt: parseCSVDate(inline.eventStartsAt),
    paymentSplit: inline.paymentSplit,
    eventNotes: inline.eventNotes || ''
  };

  const payerEmail = inline.payerEmail || '';
  const key =
    inline.groupKey ||
    inline.orderId ||
    `${payerEmail.toLowerCase()}::${event.slug}::inline`;

  return {
    key,
    event,
    orderIdRaw: inline.orderId || null,
    objectId: maybeObjectId(inline.orderId),
    seasonCode: inline.seasonCode || event.seasonCode,
    venueSlug: inline.venueSlug || event.venueSlug,
    payerFirstName: inline.payerFirstName || '',
    payerLastName: inline.payerLastName || '',
    payerEmail,
    paymentSplit,
    totalCents,
    status,
    lines,
    meta,
    createdAt,
    groupKey: inline.groupKey || key,
    providerName: inline.providerName || inline.paymentProvider || 'import',
    itemName: inline.itemName || ''
  };
}

export async function importEventOrders({
  csvPath,
  inlineOrders = [],
  dryRun = true,
  force = false,
  sendEmail = false,
  statusOverride = null,
  eventOverride = null,
  paths = {},
  logger: providedLogger = console
} = {}) {
  const logger = ensureLogger(providedLogger);
  const summary = {
    created: 0,
    updated: 0,
    skipped: 0,
    results: [],
    logs: []
  };

  const rootDir = paths.rootDir || process.cwd();
  const inputsDir = paths.inputsDir || path.resolve(rootDir, 'data/inputs');
  const eventCache = new Map();

  function log(level, message, meta) {
    summary.logs.push({ level, message, meta: meta || null });
    const fn =
      (level === 'warn' && logger.warn) ||
      (level === 'error' && logger.error) ||
      (level === 'debug' && logger.debug) ||
      logger.info ||
      logger.log;
    if (typeof fn === 'function') {
      fn.call(logger, message);
    }
  }

  const candidates = [];

  if (csvPath) {
    let groups;
    try {
      groups = await loadCsvGroups(csvPath, {
        rootDir,
        inputsDir,
        eventOverride
      });
    } catch (error) {
      log('error', `✖ ${error.message}`);
      summary.skipped += 1;
      return summary;
    }

    for (const [key, pack] of groups.entries()) {
      try {
        const parsed = await orderFromGroup(key, pack, {
          statusOverride,
          eventOverride,
          eventCache
        });
        candidates.push({ key, parsed });
      } catch (error) {
        log('error', `✖ Commande ${key}: ${error.message}`);
        summary.skipped += 1;
        summary.results.push({
          key,
          status: 'skipped',
          reason: error.message
        });
      }
    }
  }

  if (Array.isArray(inlineOrders) && inlineOrders.length) {
    for (let idx = 0; idx < inlineOrders.length; idx += 1) {
      const inline = inlineOrders[idx] || {};
      const key =
        inline.key ||
        inline.groupKey ||
        inline.orderId ||
        `inline-${idx + 1}`;
      try {
        const parsed = await normalizeInlineOrder(inline, {
          statusOverride,
          eventOverride,
          eventCache
        });
        candidates.push({ key, parsed });
      } catch (error) {
        log('error', `✖ Commande ${key}: ${error.message}`);
        summary.skipped += 1;
        summary.results.push({
          key,
          status: 'skipped',
          reason: error.message
        });
      }
    }
  }

  if (!candidates.length) {
    log('info', '⚠️  Aucun ordre à traiter.');
    return summary;
  }

  for (const candidate of candidates) {
    const { key, parsed } = candidate;

    if (!parsed.payerEmail) {
      const message = `✖ Commande ${key}: payerEmail manquant`;
      log('error', message);
      summary.skipped += 1;
      summary.results.push({ key, status: 'skipped', reason: 'missing_payer_email' });
      continue;
    }

    const seatIds = collectSeatIds(parsed.lines);

    if (!force) {
      try {
        const conflicts = await detectSeatConflicts(
          parsed,
          seatIds,
          parsed.objectId ? String(parsed.objectId) : null
        );
        if (conflicts.length) {
          conflicts.forEach((conflict) => {
            if (conflict.reason === 'seat_not_found') {
              log('warn', `  ↳ Seat introuvable ${conflict.seatId} pour ${key}`);
            } else if (conflict.reason === 'duplicate_in_csv') {
              log('warn', `  ↳ Seat ${conflict.seatId} dupliqué dans le CSV (${key})`);
            } else if (conflict.reason === 'already_booked') {
              log(
                'warn',
                `  ↳ Seat ${conflict.seatId} déjà réservé (order=${conflict.orderId}, status=${conflict.status})`
              );
            }
          });
          summary.skipped += 1;
          summary.results.push({
            key,
            status: 'skipped',
            reason: 'seat_conflict',
            conflicts
          });
          continue;
        }
      } catch (error) {
        log(
          'error',
          `✖ Commande ${key}: échec vérification sièges (${error.message})`
        );
        summary.skipped += 1;
        summary.results.push({
          key,
          status: 'skipped',
          reason: 'seat_check_failed',
          error: error.message
        });
        continue;
      }
    }

    if (dryRun) {
      log(
        'info',
        `• [DRY] ${key} event=${parsed.event.slug} lines=${parsed.lines.length} status=${parsed.status} payer=${parsed.payerEmail}`
      );
      summary.results.push({
        key,
        status: 'dry-run',
        lines: parsed.lines.length,
        event: parsed.event.slug
      });
      continue;
    }

    let existing = null;
    if (parsed.objectId) {
      existing = await Order.findById(parsed.objectId);
    } else if (parsed.orderIdRaw) {
      try {
        existing = await Order.findById(parsed.orderIdRaw);
      } catch {
        existing = null;
      }
    }

    if (
      existing &&
      existing.meta?.eventId &&
      String(existing.meta.eventId) !== String(parsed.event._id) &&
      !force
    ) {
      log(
        'warn',
        `  ↳ Commande ${existing._id} rattachée à un autre évènement (${existing.meta.eventId}), skip (ajoutez --force pour écraser).`
      );
      summary.skipped += 1;
      summary.results.push({
        key,
        status: 'skipped',
        reason: 'event_mismatch',
        orderId: String(existing._id)
      });
      continue;
    }

    const orderDoc = buildOrderDoc(parsed, existing);
    orderDoc.paymentProvider =
      parsed.providerName ||
      existing?.paymentProvider ||
      currentPaymentProviderLabel();

    if (!orderDoc.meta) {
      orderDoc.meta = {};
    }
    if (!Array.isArray(orderDoc.meta.tickets) || !orderDoc.meta.tickets.length) {
      orderDoc.meta.tickets = parsed.lines.map((line) => ({
        seatId: line.seatId || '',
        zoneKey: line.zoneKey,
        tariff: line.tariffCode,
        tariffCode: line.tariffCode,
        priceCents: line.priceCents,
        holderFirstName: line.holderFirstName || '',
        holderLastName: line.holderLastName || ''
      }));
    }
    let order;

    if (existing) {
      existing.set(orderDoc);
      order = await existing.save();
      summary.updated += 1;
      log(
        'info',
        `↺ update: ${order._id} event=${parsed.event.slug} lines=${parsed.lines.length} status=${parsed.status}`
      );
      summary.results.push({
        key,
        status: 'updated',
        orderId: String(order._id),
        lines: parsed.lines.length
      });
    } else {
      const payload = { ...orderDoc };
      if (parsed.objectId) payload._id = parsed.objectId;
      order = await Order.create(payload);
      summary.created += 1;
      log(
        'info',
        `✓ insert: ${order._id} event=${parsed.event.slug} lines=${parsed.lines.length} status=${parsed.status}`
      );
      summary.results.push({
        key,
        status: 'created',
        orderId: String(order._id),
        lines: parsed.lines.length
      });
    }

    if (sendEmail && isPaidLike(parsed.status)) {
      try {
        await ensureTicketsForEventOrder(order);
        await sendOrderAttestationIfNeeded(order, { source: 'importer:event-orders' });
        log('info', `  ↳ Confirmation envoyée: ${order.payerEmail}`);
      } catch (error) {
        log(
          'error',
          `  ✉️  Échec envoi email pour ${order._id}: ${error.message}`
        );
      }
    } else if (sendEmail && !isPaidLike(parsed.status)) {
      log(
        'warn',
        `  ↳ Email non envoyé (status=${parsed.status} non payé) pour ${parsed.payerEmail}`
      );
    }
  }

  return summary;
}

export default importEventOrders;
