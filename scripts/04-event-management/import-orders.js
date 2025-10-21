#!/usr/bin/env node
/**
 * Import event (match) orders from a CSV file.
 *
 * Usage:
 *   node scripts/04-event-management/import-orders.js <path/orders.csv> [--status=paid] [--commit] [--force] [--sendEmail]
 *
 * Notes:
 *   - CSV format follows the standard orders export: orderId,createdAt,status,payerFirstName,payerLastName,payerEmail,seasonCode,venueSlug,paymentSplit,totalCents,providerName,haOrderId,checkoutIntentId,lastReturnCode,lastWebhookEvent,attestationSentAt,lineIndex,seatId,zoneKey,tariffCode,priceCents,holderFirstName,holderLastName,eventId,eventSlug,eventName,eventStartsAt
 *   - Rows with the same orderId/orderRef/groupKey are grouped inside a single order.
 *   - When orderId is omitted, the script groups by orderRef/groupKey if present; otherwise each row becomes a distinct order.
 *   - Dry-run by default; pass --commit to persist. --sendEmail only works with --commit.
 *   - Use --force to bypass seat existence/conflict checks (useful for troubleshooting legacy data).
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import minimist from 'minimist';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { Event } from '../../src/models/Event.js';
import { Order } from '../../src/models/Order.js';
import { Seat } from '../../src/models/Seat.js';
import { sendOrderAttestationIfNeeded, isPaidLike } from '../../src/services/order-finalization.js';

const args = minimist(process.argv.slice(2), {
  boolean: ['commit', 'force', 'sendEmail', 'sendEmails', 'dryRun'],
  string: ['status', 'event', 'eventId', 'eventSlug', 'file', 'csv'],
  alias: {
    file: ['csv'],
    sendEmail: ['send', 'mail'],
    sendEmails: ['emails']
  }
});

const csvPathArg = args.file || args.csv || args._[0] || '';
const STATUS_OVERRIDE = args.status ? String(args.status).trim().toLowerCase() : null;
const EVENT_OVERRIDE_RAW = args.event || args.eventId || args.eventSlug || '';

const COMMIT = !!args.commit;
const FORCE = !!args.force;
const WANT_EMAIL = !!args.sendEmail || !!args.sendEmails || !!args.send || !!args.mail || false;
const SEND_EMAIL = WANT_EMAIL && COMMIT;
const DRY_RUN = args.dryRun === true ? true : !COMMIT;

const ALLOWED_STATUS = new Set(['pending', 'paid', 'failed', 'canceled', 'authorized', 'processed']);

function usage() {
  console.error('Usage: node scripts/04-event-management/import-orders.js <path/orders.csv> [--status=paid] [--commit] [--force] [--sendEmail]');
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

  for await (const raw of rl) {
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
      if (!header[i]) continue;
      row[header[i]] = cols[i] ?? '';
    }

    const orderId = (row.orderId || '').trim();
    let groupKey = orderId || row.orderRef?.trim() || row.groupKey?.trim();
    if (!groupKey) {
      auto += 1;
      const email = row.payerEmail ? String(row.payerEmail).trim().toLowerCase() : `row-${auto}`;
      const evRef = row.eventSlug?.trim() || row.eventId?.trim() || String(EVENT_OVERRIDE_RAW || 'event');
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

  if (!candidates.length) throw new Error('eventId/eventSlug manquant');

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
      // ignore failed candidate, try next
    }
  }

  if (!ev) throw new Error(`Événement introuvable (candidats: ${candidates.map(c => `${c.kind}=${c.value}`).join(', ')})`);

  eventCache.set(`id:${ev._id}`, ev);
  eventCache.set(`slug:${ev.slug}`, ev);
  return ev;
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
      throw new Error(`Impossible de dupliquer la ligne avec seatId=${seatRaw} (quantity=${quantity}). Dupliquez la ligne dans le CSV.`);
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
        lineIndex: (quantity === 1) ? baseIndex : baseIndex + i,
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
  return Array.from(new Set(
    lines
      .map(l => String(l.seatId || '').trim())
      .filter(Boolean)
  ));
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
  if (meta.eventStartsAt || event.startsAt) mergedMeta.eventStartsAt = meta.eventStartsAt ? new Date(meta.eventStartsAt) : event.startsAt;
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
    lines: lines.map(l => ({
      seatId: l.seatId,
      zoneKey: l.zoneKey,
      tariffCode: l.tariffCode,
      priceCents: l.priceCents,
      holderFirstName: l.holderFirstName || '',
      holderLastName:  l.holderLastName  || ''
    })),
    createdAt,
    updatedAt: createdAt
  };

  if (meta.paymentSplit && !Number.isNaN(Number(meta.paymentSplit))) {
    doc.paymentSplit = Number(meta.paymentSplit);
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
    eventId: first.eventId,
    eventSlug: first.eventSlug
  });

  const lines = sanitizeLines(rows);
  const status = normalizeStatus(first.status);
  const createdAt = parseCSVDate(first.createdAt) || new Date();
  const paymentSplit = toNumber(first.paymentSplit || 1, 1);
  const totalCentsRaw = toNumber(first.totalCents || 0, 0);
  const totalCents = lines.reduce((acc, l) => acc + (Number(l.priceCents) || 0), 0) || totalCentsRaw;
  const groupKey = deriveGroupKey(first, pack.orderId || key);

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

async function main() {
  const groups = await loadRows(csvPathArg);
  if (!groups.size) {
    console.log('⚠️  CSV vide, rien à importer.');
    return;
  }

  await mongoose.connect(mongoUri, { dbName: process.env.MONGODB_DB });

  console.log(DRY_RUN ? '🧪 Dry-run — aucune écriture.' : '⚠️  Commit activé — écriture en base.');
  if (WANT_EMAIL && !COMMIT) {
    console.warn('ℹ️  --sendEmail ignoré en dry-run.');
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

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

    if (DRY_RUN) {
      console.log(`• [DRY] ${key} event=${parsed.event.slug} lines=${parsed.lines.length} status=${parsed.status} payer=${parsed.payerEmail}`);
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
      console.log(`↺ update: ${order._id} event=${parsed.event.slug} lines=${parsed.lines.length} status=${parsed.status}`);
    } else {
      const payload = { ...orderDoc };
      if (parsed.objectId) payload._id = parsed.objectId;
      order = await Order.create(payload);
      created++;
      console.log(`✓ insert: ${order._id} event=${parsed.event.slug} lines=${parsed.lines.length} status=${parsed.status}`);
    }

    if (SEND_EMAIL && isPaidLike(parsed.status)) {
      try {
        await sendOrderAttestationIfNeeded(order);
        console.log(`  ↳ Confirmation envoyée: ${order.payerEmail}`);
      } catch (err) {
        console.error(`  ✉️  Échec envoi email pour ${order._id}: ${err.message}`);
      }
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
