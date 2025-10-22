#!/usr/bin/env node
/**
 * Import external invitations (with pre-defined QR codes) as event orders.
 *
 * Usage:
 *   node scripts/04-event-management/import-invitations-with-qr.js <path/invitations.csv> [--status=paid] [--commit] [--force] [--event=<idOrSlug>] [--qrColumn=qrHex] [--no-finalize]
 *
 * CSV expectations (per ticket row):
 *   - Supports the same columns as import-orders.js (orderId, createdAt, payer*, seatId/zoneKey, tariffCode, etc.)
 *   - Requires at least one QR column: qrHex, qrValue, qr, qr_code, qrcode, or custom via --qrColumn.
 *   - For rows with quantity > 1, provide the same number of QR values separated by "|" or as qr1, qr2, ...
 *
 * Behaviour:
 *   - Groups rows by orderId/orderRef/groupKey like the standard importer.
 *   - Persists orders with meta.tickets hydrated from the provided QR codes.
 *   - Optionally finalizes tickets (default) to ensure scanning works immediately.
 *   - Dry-run by default; add --commit to apply changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import minimist from 'minimist';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

import { Event } from '../../src/models/Event.js';
import { Order } from '../../src/models/Order.js';
import { Seat } from '../../src/models/Seat.js';
import { Ticket } from '../../src/models/Ticket.js';
import { ensureTicketsForEventOrder, isPaidLike } from '../../src/services/order-finalization.js';

dotenv.config();

const args = minimist(process.argv.slice(2), {
  boolean: ['commit', 'force', 'dryRun', 'finalize'],
  string: ['status', 'event', 'eventId', 'eventSlug', 'file', 'csv', 'qrColumn'],
  alias: {
    file: ['csv'],
    event: ['eventSlug'],
  },
  default: {
    finalize: true
  }
});

const csvPathArg = args.file || args.csv || args._[0] || '';
const STATUS_OVERRIDE = args.status ? String(args.status).trim().toLowerCase() : null;
const EVENT_OVERRIDE_RAW = args.event || args.eventId || args.eventSlug || '';
const QR_COLUMN_OVERRIDE = args.qrColumn ? String(args.qrColumn).trim() : '';

const COMMIT = !!args.commit;
const FORCE = !!args.force;
const DRY_RUN = args.dryRun === true ? true : !COMMIT;
const SHOULD_FINALIZE = args.finalize !== false;

const ALLOWED_STATUS = new Set(['pending', 'paid', 'failed', 'canceled', 'authorized', 'processed']);

function usage() {
  console.error('Usage: node scripts/04-event-management/import-invitations-with-qr.js <path/invitations.csv> [--status=paid] [--commit] [--force] [--event=<idOrSlug>] [--qrColumn=qrHex] [--no-finalize]');
  process.exit(1);
}

if (!csvPathArg) usage();

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!mongoUri) {
  console.error('❌ MONGO_URI/MONGODB_URI manquant');
  process.exit(1);
}

const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');

const resolveCsvPath = (p) => {
  if (!p) return p;
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return abs;
  const inInputs = path.resolve(INPUT_DIR, p);
  if (fs.existsSync(inInputs)) return inInputs;
  return abs;
};

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseCSVDate(s) {
  if (!s) return null;
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function maybeObjectId(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(str)) return null;
  try { return new mongoose.Types.ObjectId(str); }
  catch { return null; }
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parsePrice(row) {
  let cents = toNumber(row.priceCents, NaN);
  if (!Number.isFinite(cents) || cents < 0) {
    const euro = row.priceEuro ?? row.price ?? null;
    if (euro !== null && euro !== undefined && euro !== '') {
      const euroNum = Number(euro);
      if (Number.isFinite(euroNum)) cents = Math.round(euroNum * 100);
    }
  }
  if (!Number.isFinite(cents) || cents < 0) return 0;
  return cents;
}

function normalizeStatus(raw) {
  const s = String(raw || STATUS_OVERRIDE || 'paid').trim().toLowerCase();
  if (!s) return 'paid';
  if (ALLOWED_STATUS.has(s)) return s;
  if (/^(success|succeeded|ok)$/i.test(s)) return 'paid';
  if (/^(authorised|authorized_ok)$/i.test(s)) return 'authorized';
  return ALLOWED_STATUS.has(STATUS_OVERRIDE || '') ? STATUS_OVERRIDE : 'paid';
}

function deriveGroupKey(firstRow, fallbackId) {
  return firstRow.groupKey?.trim() ||
    firstRow.orderRef?.trim() ||
    firstRow.group?.trim() ||
    firstRow.orderGroup?.trim() ||
    (firstRow.payerEmail ? `${String(firstRow.payerEmail).toLowerCase().trim()}#${firstRow.eventSlug || firstRow.eventId || 'event'}` : '') ||
    fallbackId;
}

function normalizeColumnKey(name) {
  return String(name || '')
    .trim()
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function getRowField(row, name) {
  if (!row || !name) return '';
  if (row[name] !== undefined) return row[name];
  const lower = String(name).toLowerCase();
  if (row[lower] !== undefined) return row[lower];
  const normalized = normalizeColumnKey(name);
  if (normalized && row[normalized] !== undefined) return row[normalized];
  return '';
}

async function loadRows(csvPath) {
  const full = resolveCsvPath(csvPath);
  if (!fs.existsSync(full)) throw new Error(`CSV introuvable: ${csvPath} (${full})`);

  const rl = readline.createInterface({
    input: fs.createReadStream(full, 'utf8'),
    crlfDelay: Infinity
  });

  let headerParsed = false;
  let header = [];
  const groups = new Map(); // key -> { key, orderId, rows: [] }
  let auto = 0;
  let lineNumber = 0;

  for await (const raw of rl) {
    lineNumber += 1;
    const line = raw.trimEnd();
    if (!line) continue;
    const cols = parseCsvLine(line);
    if (!headerParsed) {
      header = cols.map(c => c.trim());
      headerParsed = true;
      continue;
    }

    const row = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i];
      if (!key) continue;
      const trimmedKey = key.trim();
      const value = cols[i] ?? '';
      row[trimmedKey] = value;
      const normalized = normalizeColumnKey(trimmedKey);
      if (normalized && !(normalized in row)) {
        row[normalized] = value;
      }
    }
    row.__lineNumber = lineNumber;

    const orderId = (row.orderId || row.orderid || '').trim();
    let groupKey = orderId || row.orderRef?.trim() || row.orderref?.trim() || row.groupKey?.trim() || row.groupkey?.trim();
    if (!groupKey) {
      auto += 1;
      const email = row.payerEmail ? String(row.payerEmail).trim().toLowerCase() : `row-${auto}`;
      const evRef = row.eventSlug?.trim() || row.eventslug?.trim() || row.eventId?.trim() || row.eventid?.trim() || String(EVENT_OVERRIDE_RAW || 'event');
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

const eventCache = new Map();

async function resolveEvent({ eventId, eventSlug }) {
  const candidates = [];
  const idTrim = eventId ? String(eventId).trim() : '';
  const slugTrim = eventSlug ? String(eventSlug).trim() : '';
  const override = EVENT_OVERRIDE_RAW ? String(EVENT_OVERRIDE_RAW).trim() : '';

  if (idTrim) candidates.push({ kind: 'id', value: idTrim });
  if (slugTrim) candidates.push({ kind: 'slug', value: slugTrim });
  if (override) {
    const isId = mongoose.Types.ObjectId.isValid(override);
    candidates.push({ kind: isId ? 'id' : 'slug', value: override });
  }

  if (!candidates.length) throw new Error('eventId/eventSlug requis (ou --event)');

  for (const cand of candidates) {
    const cacheKey = `${cand.kind}:${cand.value}`;
    if (eventCache.has(cacheKey)) return eventCache.get(cacheKey);
  }

  let ev = null;
  for (const cand of candidates) {
    try {
      if (cand.kind === 'id') {
        if (mongoose.Types.ObjectId.isValid(cand.value)) {
          ev = await Event.findById(cand.value).lean();
        }
        if (!ev) {
          ev = await Event.findOne({ $or: [{ _id: cand.value }, { slug: cand.value }] }).lean();
        }
      } else {
        ev = await Event.findOne({ slug: cand.value }).lean();
      }
      if (ev) break;
    } catch {
      // try next
    }
  }

  if (!ev) throw new Error(`Événement introuvable (candidats: ${candidates.map(c => `${c.kind}=${c.value}`).join(', ')})`);

  eventCache.set(`id:${ev._id}`, ev);
  eventCache.set(`slug:${ev.slug}`, ev);
  return ev;
}

function splitQrList(raw) {
  if (!raw) return [];
  const str = String(raw).trim();
  if (!str) return [];
  return str
    .split(/[|;\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

const QR_COLUMN_CANDIDATES = [
  () => QR_COLUMN_OVERRIDE,
  'qrHex', 'qrValue', 'qr', 'qr_code', 'qrcode', 'ticketQr', 'ticketQR'
].filter(Boolean);

function extractQrValues(row, quantity) {
  const values = [];
  for (const candidate of QR_COLUMN_CANDIDATES) {
    const name = typeof candidate === 'function' ? candidate() : candidate;
    if (!name) continue;
    const data = getRowField(row, name);
    if (!data) continue;
    for (const v of splitQrList(data)) {
      values.push(v);
    }
    if (values.length >= quantity) break;
  }

  if (values.length < quantity) {
    const qrIndexedKeys = Array.from(new Set(Object.keys(row)))
      .filter(key => /^qr\d+$/i.test(key))
      .sort((a, b) => {
        const ai = parseInt(a.replace(/\D+/g, ''), 10) || 0;
        const bi = parseInt(b.replace(/\D+/g, ''), 10) || 0;
        return ai - bi;
      });
    for (const key of qrIndexedKeys) {
      const data = getRowField(row, key);
      for (const v of splitQrList(data)) {
        values.push(v);
      }
      if (values.length >= quantity) break;
    }
  }

  if (!values.length) {
    throw new Error('QR code manquant (colonne qrHex/qrValue/qr...)');
  }

  if (quantity > 1 && values.length < quantity) {
    throw new Error(`QR codes insuffisants pour quantity=${quantity} (trouvés ${values.length})`);
  }

  if (quantity === 1) return [values[0]];
  return values.slice(0, quantity);
}

function guessQrKind(qrValue) {
  const trimmed = String(qrValue || '').trim();
  if (/^[0-9a-f]{16,}$/i.test(trimmed)) return 'hex';
  return 'text';
}

function sanitizeLines(rows) {
  const lines = [];
  let fallbackIndex = 0;
  const seenSeats = new Set();
  const seenQr = new Set();

  for (const row of rows) {
    const seatRaw = String(row.seatId || row.seatid || '').trim();
    const zoneRaw = String(row.zoneKey || row.zone || row.zonekey || '').trim();
    const tariffRaw = String(row.tariffCode || row.tariff || row.tariffcode || '').trim();
    if (!zoneRaw && !seatRaw) {
      throw new Error('zoneKey ou seatId requis pour chaque ligne');
    }

    const quantity = Math.max(1, toNumber(row.quantity || row.qty || 1, 1));
    if (quantity > 1 && seatRaw) {
      throw new Error(`Impossible de dupliquer la ligne avec seatId=${seatRaw} (quantity=${quantity}). Dupliquez la ligne dans le CSV.`);
    }

    let qrValues;
    try {
      qrValues = extractQrValues(row, quantity);
    } catch (err) {
      const src = seatRaw || zoneRaw || `ligne ${row.__lineNumber || '?'}`;
      throw new Error(`${err.message} (ligne ${row.__lineNumber || '?'} / ${src})`);
    }

    const baseIndex = toNumber(row.lineIndex || row.lineindex, fallbackIndex);
    const priceCents = parsePrice(row);

    const seatKey = seatRaw ? seatRaw.toUpperCase() : '';
    if (seatKey) {
      if (seenSeats.has(seatKey)) {
        throw new Error(`Seat ${seatRaw} apparaît plusieurs fois dans le groupe`);
      }
      seenSeats.add(seatKey);
    }

    for (let i = 0; i < quantity; i++) {
      const qrValue = String(qrValues[i] || '').trim();
      if (!qrValue) {
        throw new Error(`QR code manquant pour la ligne (seat=${seatRaw || zoneRaw})`);
      }
      const qrUpper = qrValue.toUpperCase();
      if (seenQr.has(qrUpper)) {
        throw new Error(`QR ${qrValue} utilisé plusieurs fois dans la même commande`);
      }
      seenQr.add(qrUpper);

      lines.push({
        lineIndex: (quantity === 1) ? baseIndex : baseIndex + i,
        seatId: quantity === 1 ? seatRaw : '',
        zoneKey: zoneRaw.toUpperCase(),
        tariffCode: tariffRaw.toUpperCase() || 'NORMAL',
        priceCents,
        holderFirstName: row.holderFirstName || row.holderfirstname || '',
        holderLastName: row.holderLastName || row.holderlastname || '',
        qrValue,
        qrKind: guessQrKind(qrValue)
      });
      fallbackIndex += 1;
    }
  }

  if (!lines.length) throw new Error('Aucune ligne de billet pour cette commande');

  return lines.sort((a, b) => a.lineIndex - b.lineIndex);
}

function collectSeatIds(lines) {
  return Array.from(new Set(
    lines
      .map(l => String(l.seatId || '').trim())
      .filter(Boolean)
  ));
}

function collectQrValues(lines) {
  const seen = new Set();
  const values = [];
  for (const line of lines) {
    const raw = String(line.qrValue || '').trim();
    if (!raw) continue;
    const key = raw.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(raw);
  }
  return values;
}

function buildTicketsMeta(lines) {
  const now = new Date();
  return lines.map((line) => {
    const qrValue = String(line.qrValue || '').trim();
    const ticket = {
      seatId: line.seatId || undefined,
      zoneKey: line.zoneKey || undefined,
      tariff: line.tariffCode,
      tariffCode: line.tariffCode,
      holderFirstName: line.holderFirstName || '',
      holderLastName: line.holderLastName || '',
      status: 'imported',
      importedFrom: 'external-invitations',
      importedAt: now,
      value: qrValue
    };
    if (line.qrKind === 'hex') {
      ticket.hex = qrValue;
    }
    return ticket;
  });
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
    tickets,
    meta,
    createdAt,
    itemName
  } = parsed;

  const mergedMeta = { ...(existing?.meta || {}) };
  mergedMeta.eventId = String(event._id);
  mergedMeta.eventSlug = event.slug;
  if (meta.eventName || event.name) mergedMeta.eventName = meta.eventName || event.name;
  if (meta.eventStartsAt || event.startsAt) mergedMeta.eventStartsAt = meta.eventStartsAt ? new Date(meta.eventStartsAt) : event.startsAt;
  if (meta.eventNotes) mergedMeta.eventNotes = meta.eventNotes;
  mergedMeta.tickets = tickets;
  mergedMeta.qrImport = {
    source: 'import-invitations-with-qr',
    importedAt: new Date(),
    count: tickets.length
  };

  const paymentMeta = { ...(existing?.paymentProviderMeta || {}) };
  paymentMeta.importedAt = new Date();
  paymentMeta.source = 'import-event-invitations';
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
    paymentProvider: existing?.paymentProvider || meta.providerName || 'import',
    paymentProviderMeta: paymentMeta,
    origin: { flow: 'event', uiPath: '/event', apiPath: '/admin/import/event-invitations' },
    mailTemplateKind: 'event',
    meta: mergedMeta,
    lines: lines.map(l => ({
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

  if (meta.providerName) {
    doc.paymentProvider = meta.providerName;
  }

  if (!doc.totalCents) {
    doc.totalCents = doc.lines.reduce((acc, l) => acc + (Number(l.priceCents) || 0), 0);
  }

  return doc;
}

async function orderFromGroup(key, pack) {
  const rows = pack.rows;
  if (!rows.length) throw new Error(`Groupe ${key} vide`);
  const first = rows[0];

  const event = await resolveEvent({
    eventId: first.eventId || first.eventid,
    eventSlug: first.eventSlug || first.eventslug
  });

  const lines = sanitizeLines(rows);
  const tickets = buildTicketsMeta(lines);
  const status = normalizeStatus(first.status);
  const createdAt = parseCSVDate(first.createdAt || first.createdat) || new Date();
  const paymentSplit = toNumber(first.paymentSplit || first.paymentsplit || 1, 1);
  const totalCentsRaw = toNumber(first.totalCents || first.totalcents || 0, 0);
  const totalCents = lines.reduce((acc, l) => acc + (Number(l.priceCents) || 0), 0) || totalCentsRaw;
  const groupKey = deriveGroupKey(first, pack.orderId || key);

  const meta = {
    haOrderId: first.haOrderId || first.haorderid || '',
    checkoutIntentId: first.checkoutIntentId || first.checkoutintentid || '',
    lastReturnCode: first.lastReturnCode || first.lastreturncode || '',
    lastWebhookEvent: first.lastWebhookEvent || first.lastwebhookevent || '',
    attestationSentAt: parseCSVDate(first.attestationSentAt || first.attestationsentat),
    eventName: first.eventName || first.eventname || '',
    eventStartsAt: parseCSVDate(first.eventStartsAt || first.eventstartsat),
    paymentSplit: first.paymentSplit || first.paymentsplit,
    eventNotes: first.eventNotes || first.eventnotes || '',
    providerName: first.providerName || first.paymentProvider || first.paymentprovider || ''
  };

  return {
    key,
    event,
    orderIdRaw: pack.orderId,
    objectId: maybeObjectId(pack.orderId),
    seasonCode: first.seasonCode || first.seasoncode || event.seasonCode,
    venueSlug: first.venueSlug || first.venueslug || event.venueSlug,
    payerFirstName: first.payerFirstName || first.payerfirstname || '',
    payerLastName: first.payerLastName || first.payerlastname || '',
    payerEmail: first.payerEmail || first.payeremail || '',
    paymentSplit,
    totalCents,
    status,
    lines,
    tickets,
    meta,
    createdAt,
    groupKey,
    providerName: meta.providerName || 'import',
    itemName: first.itemName || first.itemname || ''
  };
}

async function detectSeatConflicts(parsed, seatIds, existingId) {
  if (!seatIds.length) return [];

  const conflicts = [];
  const seasonCode = parsed.seasonCode;
  const venueSlug = parsed.venueSlug;

  const seats = await Seat.find({ seasonCode, venueSlug, seatId: { $in: seatIds } }).lean();
  const knownSeats = new Set(seats.map(s => String(s.seatId)));

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

  const orderConflicts = await Order.find({
    'meta.eventId': String(parsed.event._id),
    status: { $in: ['paid', 'pending', 'processed', 'authorized'] },
    ...(existingId ? { _id: { $ne: existingId } } : {}),
    'lines.seatId': { $in: seatIds }
  }, { _id: 1, status: 1, payerEmail: 1, lines: 1 }).lean();

  for (const ord of orderConflicts) {
    for (const line of (ord.lines || [])) {
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

async function detectQrConflicts(qrValues, allowedOrderId = null) {
  if (!qrValues.length) return [];
  const allowSet = new Set();
  if (allowedOrderId) allowSet.add(String(allowedOrderId));

  const lookupValues = new Set();
  for (const value of qrValues) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    lookupValues.add(raw);
    lookupValues.add(raw.toUpperCase());
    lookupValues.add(raw.toLowerCase());
  }

  const docs = await Ticket.find(
    { 'qr.value': { $in: Array.from(lookupValues) } },
    { 'qr.value': 1, orderId: 1 }
  ).lean();
  const conflicts = [];
  for (const doc of docs) {
    const qrValue = String(doc?.qr?.value || '').trim();
    const orderId = doc?.orderId ? String(doc.orderId) : null;
    if (orderId && allowSet.has(orderId)) continue;
    conflicts.push({ qrValue, orderId });
  }
  return conflicts;
}

async function main() {
  const groups = await loadRows(csvPathArg);
  if (!groups.size) {
    console.log('⚠️  CSV vide, rien à importer.');
    return;
  }

  await mongoose.connect(mongoUri, { dbName: process.env.MONGODB_DB });

  console.log(DRY_RUN ? '🧪 Dry-run — aucune écriture.' : '⚠️  Commit activé — écriture en base.');
  if (!SHOULD_FINALIZE && !DRY_RUN) {
    console.log('ℹ️  Finalisation des tickets désactivée (--no-finalize).');
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const globalQrUsage = new Map(); // qr -> orderKey

  for (const [key, pack] of groups.entries()) {
    let parsed;
    try {
      parsed = await orderFromGroup(key, pack);
    } catch (err) {
      console.error(`✖ Commande ${key}: ${err.message}`);
      skipped++;
      continue;
    }

    if (!parsed.payerEmail) {
      console.error(`✖ Commande ${key}: payerEmail manquant`);
      skipped++;
      continue;
    }

    const localQrValues = collectQrValues(parsed.lines);
    const canonicalMap = new Map(localQrValues.map(v => [v.toUpperCase(), v]));
    let duplicateInGlobal = false;
    for (const [canon, original] of canonicalMap.entries()) {
      if (globalQrUsage.has(canon)) {
        console.error(`✖ Commande ${key}: QR ${original} déjà utilisé par ${globalQrUsage.get(canon)} (fichier)`);
        duplicateInGlobal = true;
      }
    }
    if (duplicateInGlobal) {
      skipped++;
      continue;
    }

    const seatIds = collectSeatIds(parsed.lines);

    if (!FORCE) {
      try {
        const conflicts = await detectSeatConflicts(parsed, seatIds, parsed.objectId ? String(parsed.objectId) : null);
        if (conflicts.length) {
          for (const c of conflicts) {
            if (c.reason === 'seat_not_found') {
              console.warn(`  ↳ Seat introuvable ${c.seatId} pour ${key}`);
            } else if (c.reason === 'duplicate_in_csv') {
              console.warn(`  ↳ Seat ${c.seatId} dupliqué dans le CSV (${key})`);
            } else if (c.reason === 'already_booked') {
              console.warn(`  ↳ Seat ${c.seatId} déjà réservé (order=${c.orderId}, status=${c.status})`);
            }
          }
          skipped++;
          continue;
        }
      } catch (err) {
        console.error(`✖ Commande ${key}: échec vérification sièges (${err.message})`);
        skipped++;
        continue;
      }
    }

    if (!FORCE && localQrValues.length) {
      try {
        const qrConflicts = await detectQrConflicts(localQrValues, parsed.objectId ? String(parsed.objectId) : null);
        if (qrConflicts.length) {
          for (const c of qrConflicts) {
            if (c.orderId) {
              console.warn(`  ↳ QR ${c.qrValue} déjà lié à l'ordre ${c.orderId}`);
            } else {
              console.warn(`  ↳ QR ${c.qrValue} déjà utilisé`);
            }
          }
          skipped++;
          continue;
        }
      } catch (err) {
        console.error(`✖ Commande ${key}: échec vérification QR (${err.message})`);
        skipped++;
        continue;
      }
    }

    const summary = `event=${parsed.event.slug} lines=${parsed.lines.length} status=${parsed.status} payer=${parsed.payerEmail}`;
    if (DRY_RUN) {
      console.log(`• [DRY] ${key} ${summary} QR=${localQrValues.length}`);
      for (const canon of canonicalMap.keys()) {
        globalQrUsage.set(canon, key);
      }
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

    if (existing && existing.meta?.eventId && String(existing.meta.eventId) !== String(parsed.event._id) && !FORCE) {
      console.warn(`  ↳ Commande ${existing._id} rattachée à un autre évènement (${existing.meta.eventId}), skip (ajoutez --force pour écraser).`);
      skipped++;
      continue;
    }

    const orderDoc = buildOrderDoc(parsed, existing);
    let order;

    if (existing) {
      existing.set(orderDoc);
      order = await existing.save();
      updated++;
      console.log(`↺ update: ${order._id} ${summary}`);
    } else {
      const payload = { ...orderDoc };
      if (parsed.objectId) payload._id = parsed.objectId;
      order = await Order.create(payload);
      created++;
      console.log(`✓ insert: ${order._id} ${summary}`);
    }

    for (const canon of canonicalMap.keys()) {
      globalQrUsage.set(canon, key);
    }

    if (SHOULD_FINALIZE && isPaidLike(parsed.status)) {
      try {
        const result = await ensureTicketsForEventOrder(order);
        if ((result.created || result.updated) && (result.created + result.updated) > 0) {
          console.log(`  ↳ Tickets: created=${result.created} updated=${result.updated}`);
        }
      } catch (err) {
        console.error(`  ✖ Finalisation tickets échouée (${err.message})`);
      }
    } else if (!isPaidLike(parsed.status)) {
      console.log('  ↳ Tickets non finalisés (status non payé).');
    }
  }

  console.log('— Résumé —');
  console.log(`Orders: created=${created} updated=${updated} skipped=${skipped}`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌ ERROR:', err?.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
