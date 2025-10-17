#!/usr/bin/env node
/**
 * Import subscription orders (phase=subscription) from a CSV file.
 *
 * Usage:
 *   node scripts/03-season-management/import-subscription-orders.js <path/orders.csv> [--season=2025-2026] [--venue=patinoire-blagnac] [--status=paid] [--commit] [--force] [--sendEmails]
 *
 * Notes:
 *   - CSV columns follow the export format: orderId,createdAt,phase,status,payerFirstName,payerLastName,payerEmail,seasonCode,venueSlug,paymentSplit,totalCents,providerName,haOrderId,checkoutIntentId,lastReturnCode,lastWebhookEvent,attestationSentAt,lineIndex,seatId,zoneKey,tariffCode,priceCents,holderFirstName,holderLastName
 *   - Only orders with phase=subscription are created/updated.
 *   - By default runs in dry-run mode; add --commit to persist.
 *   - Use --force to ignore seat availability checks.
 *   - Use --sendEmails (with --commit) to send confirmation emails.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import minimist from 'minimist';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { Order } from '../../src/models/Order.js';
import { Seat } from '../../src/models/Seat.js';
import { Subscriber } from '../../src/models/Subscriber.js';
import { sendOrderAttestationIfNeeded } from '../../src/services/order-finalization.js';

const args = minimist(process.argv.slice(2), {
  boolean: ['commit', 'force', 'sendEmails', 'dryRun'],
  string: ['season', 'venue', 'status', 'file'],
  alias: {
    commit: ['apply'],
    sendEmails: ['send', 'mail'],
    dryRun: ['dry', 'test']
  }
});

const csvPathArg = args.file || args._[0] || '';
const SEASON_OVERRIDE = args.season || null;
const VENUE_OVERRIDE  = args.venue  || null;
const ORDER_STATUS    = String(args.status || '').toLowerCase() || null;
const COMMIT = !!args.commit;
const FORCE  = !!args.force;
const SEND_EMAILS = !!args.sendEmails && COMMIT;
const DRY_RUN = args.dryRun === true ? true : !COMMIT;

function usage() {
  console.error('Usage: node scripts/03-season-management/import-subscription-orders.js <path/orders.csv> [--season=...] [--venue=...] [--status=paid] [--commit] [--force] [--sendEmails]');
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

const CSV_COLUMNS = [
  'orderId', 'createdAt', 'phase', 'status',
  'payerFirstName', 'payerLastName', 'payerEmail',
  'seasonCode', 'venueSlug', 'paymentSplit', 'totalCents',
  'providerName', 'haOrderId', 'checkoutIntentId', 'lastReturnCode', 'lastWebhookEvent', 'attestationSentAt',
  'lineIndex', 'seatId', 'zoneKey', 'tariffCode', 'priceCents', 'holderFirstName', 'holderLastName'
];

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
  return isNaN(dt.getTime()) ? null : dt;
}

function maybeObjectId(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(str)) return null;
  try { return new mongoose.Types.ObjectId(str); }
  catch { return null; }
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  const orderLines = new Map(); // orderId -> { header, lines: [] }

  for await (const raw of rl) {
    const line = raw.trimEnd();
    if (!line) continue;
    const cols = parseCsvLine(line);
    if (!headerParsed) {
      header = cols.map(c => c.trim());
      const missing = CSV_COLUMNS.filter(col => !header.includes(col));
      if (missing.length) {
        throw new Error(`Colonnes manquantes: ${missing.join(', ')}`);
      }
      headerParsed = true;
      continue;
    }

    const row = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]] = cols[i];
    }

    const orderId = row.orderId?.trim();
    if (!orderId) continue;

    if (!orderLines.has(orderId)) {
      orderLines.set(orderId, { rows: [] });
    }
    orderLines.get(orderId).rows.push(row);
  }

  return orderLines;
}

function orderFromRows(orderId, group) {
  const rows = group.rows;
  if (!rows.length) return null;

  const first = rows[0];
  const seasonCode = first.seasonCode || SEASON_OVERRIDE;
  const venueSlug  = first.venueSlug  || VENUE_OVERRIDE;
  if (!seasonCode) throw new Error(`seasonCode manquant pour la commande ${orderId}`);
  if (!venueSlug)  throw new Error(`venueSlug manquant pour la commande ${orderId}`);

  const phase = (first.phase || 'subscription').toLowerCase();
  if (phase !== 'subscription') {
    throw new Error(`Commande ${orderId} avec phase="${phase}", attendu "subscription"`);
  }

  const statusCsv = (first.status || '').toLowerCase();
  const status = (ORDER_STATUS || statusCsv || 'paid').toLowerCase();

  const payerFirstName = first.payerFirstName || '';
  const payerLastName  = first.payerLastName  || '';
  const payerEmail     = first.payerEmail     || '';

  const paymentSplit = toNumber(first.paymentSplit || 1, 1);
  const totalCentsCsv = toNumber(first.totalCents || 0, 0);

  const createdAt = parseCSVDate(first.createdAt) || new Date();

  const lines = rows.map((row, idx) => ({
    lineIndex: toNumber(row.lineIndex || idx, idx),
    seatId: row.seatId || '',
    zoneKey: row.zoneKey || '',
    tariffCode: (row.tariffCode || '').toUpperCase(),
    priceCents: toNumber(row.priceCents || 0, 0),
    holderFirstName: row.holderFirstName || '',
    holderLastName:  row.holderLastName  || ''
  })).sort((a, b) => a.lineIndex - b.lineIndex);

  const totalCents = lines.reduce((acc, l) => acc + (l.priceCents || 0), 0) || totalCentsCsv;

  const groupKey = first.groupKey || first.orderRef || orderId;

  return {
    orderId,
    objectId: maybeObjectId(orderId),
    seasonCode,
    venueSlug,
    payerFirstName,
    payerLastName,
    payerEmail,
    paymentSplit,
    totalCents,
    status,
    createdAt,
    lines,
    groupKey,
    meta: {
      providerName: first.providerName || '',
      haOrderId: first.haOrderId || '',
      checkoutIntentId: first.checkoutIntentId || '',
      lastReturnCode: first.lastReturnCode || '',
      lastWebhookEvent: first.lastWebhookEvent || '',
      attestationSentAt: parseCSVDate(first.attestationSentAt)
    }
  };
}

async function main() {
  const groups = await loadRows(csvPathArg);
  if (!groups.size) {
    console.log('⚠️  CSV vide, rien à importer.');
    return;
  }

  await mongoose.connect(mongoUri, { dbName: process.env.MONGODB_DB });

  console.log(DRY_RUN ? '🧪 Dry-run — aucune écriture.' : '⚠️  Commit activé — écriture en base.');
  if (!DRY_RUN && !COMMIT) {
    console.warn('⚠️  (--commit non spécifié, passage en dry-run).');
  }
  if (SEND_EMAILS && DRY_RUN) {
    console.warn('ℹ️  --sendEmails ignoré en dry-run.');
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let bookedSeats = 0;
  let subscriberUpserts = 0;
  let subscriberUpdates = 0;

  for (const [orderId, pack] of groups.entries()) {
    let parsed;
    try {
      parsed = orderFromRows(orderId, pack);
    } catch (err) {
      console.error(`✖ Impossible de parser la commande ${orderId}: ${err.message}`);
      skipped++;
      continue;
    }

    const { seasonCode, venueSlug, payerEmail, lines } = parsed;
    const status = parsed.status;
    const lineSeatIds = Array.from(new Set(lines.map(l => l.seatId).filter(Boolean)));

    let seatMap = new Map();
    if (lineSeatIds.length) {
      const seats = await Seat.find({ seasonCode, venueSlug, seatId: { $in: lineSeatIds } }).lean();
      seatMap = new Map(seats.map(s => [s.seatId, s]));
    }

    if (!FORCE) {
      let seatIssue = false;
      for (const seatId of lineSeatIds) {
        const seat = seatMap.get(seatId);
        if (!seat) {
          console.warn(`  ↳ Seat introuvable ${seatId} pour ${orderId}`);
          seatIssue = true;
          continue;
        }
        const st = String(seat.status || '').toLowerCase();
        if (st !== 'available' && st !== 'provisioned') {
          console.warn(`  ↳ Seat ${seatId} non disponible (status=${st})`);
          seatIssue = true;
        }
      }
      if (seatIssue) {
        skipped++;
        continue;
      }
    }

    if (DRY_RUN) {
      console.log(`• [DRY] ${orderId} seats=${lines.length} payer=${payerEmail} status=${status}`);
      continue;
    }

    let existing = null;
    if (parsed.objectId) {
      existing = await Order.findById(parsed.objectId);
    } else {
      try {
        existing = await Order.findById(orderId);
      } catch { existing = null; }
    }

    const orderDoc = {
      ...(existing ? { _id: existing._id } : (parsed.objectId ? { _id: parsed.objectId } : {})),
      seasonCode,
      venueSlug,
      phase: 'subscription',
      groupKey: parsed.groupKey || groupKey,
      payerFirstName: parsed.payerFirstName || '',
      payerLastName:  parsed.payerLastName  || '',
      payerEmail,
      paymentSplit: parsed.paymentSplit || 1,
      lines: lines.map(l => ({
        seatId: l.seatId,
        zoneKey: l.zoneKey || (l.seatId ? String(l.seatId).split('-')[0] : ''),
        tariffCode: l.tariffCode || 'NORMAL',
        priceCents: l.priceCents || 0,
        holderFirstName: l.holderFirstName || '',
        holderLastName:  l.holderLastName  || ''
      })),
      totalCents: parsed.totalCents || 0,
      status,
      paymentProvider: parsed.meta.providerName || 'import',
      paymentProviderMeta: {
        importedAt: new Date(),
        source: 'import-subscription-orders',
        haOrderId: parsed.meta.haOrderId || undefined,
        checkoutIntentId: parsed.meta.checkoutIntentId || undefined,
        lastReturnCode: parsed.meta.lastReturnCode || undefined,
        lastWebhookEvent: parsed.meta.lastWebhookEvent || undefined,
        attestationSentAt: parsed.meta.attestationSentAt || undefined
      },
      origin: {
        flow: 'subscription',
        uiPath: '/subscription',
        apiPath: '/admin/import/subscription-orders'
      },
      mailTemplateKind: 'subscription',
      createdAt: parsed.createdAt,
      updatedAt: parsed.createdAt
    };

    let order;
    if (existing) {
      existing.set(orderDoc);
      order = await existing.save();
      updated++;
      console.log(`↺ update: ${orderId}`);
    } else {
      order = await Order.create(orderDoc);
      created++;
      console.log(`✓ insert: ${orderId}`);
    }

    const subscriberIds = [];
    for (const line of lines) {
      const seatId = String(line.seatId || '').trim();
      if (!seatId) continue;
      const subscriberFilter = {
        email: payerEmail.toLowerCase(),
        seasonCode,
        venueSlug,
        prefSeatId: seatId
      };
      const subscriberUpdate = {
        $set: {
          firstName: line.holderFirstName || parsed.payerFirstName || '',
          lastName:  line.holderLastName  || parsed.payerLastName  || '',
          email: payerEmail.toLowerCase(),
          phone: '',
          prefSeatId: seatId,
          seasonCode,
          venueSlug,
          groupKey: parsed.groupKey || groupKey,
          status: status === 'paid' ? 'active' : 'pending'
        },
        $addToSet: { previousSeasonSeats: seatId }
      };

      const subRes = await Subscriber.updateOne(
        subscriberFilter,
        subscriberUpdate,
        { upsert: true, setDefaultsOnInsert: true }
      );
      if ((subRes.upsertedCount ?? 0) > 0) subscriberUpserts++;
      else if ((subRes.modifiedCount ?? subRes.nModified ?? 0) > 0) subscriberUpdates++;

      const subscriberDoc = await Subscriber.findOne(subscriberFilter).lean();
      if (subscriberDoc?._id) subscriberIds.push({ seatId, subscriberId: subscriberDoc._id });
    }

    let seatsBookedHere = 0;
    if (/^paid$/i.test(status)) {
      for (const line of lines) {
        if (!line.seatId) continue;
        const seatFilter = {
          seasonCode,
          venueSlug,
          seatId: line.seatId
        };
        if (!FORCE) seatFilter.status = { $in: ['available', 'provisioned'] };

        const seatUpdate = {
          $set: { status: 'booked' },
          $unset: { 'meta.hold': '' }
        };
        const matchSubscriber = subscriberIds.find(s => s.seatId === line.seatId);
        if (matchSubscriber) {
          seatUpdate.$set.provisionedFor = matchSubscriber.subscriberId;
        }
        const res = await Seat.updateOne(seatFilter, seatUpdate, { runValidators: false });
        const mod = res.modifiedCount ?? res.nModified ?? 0;
        seatsBookedHere += mod;
      }
      bookedSeats += seatsBookedHere;
      if (!seatsBookedHere) {
        console.warn(`  ↳ Aucun siège booké pour ${orderId} (déjà réservé ?)`);
      }
    }

    if (SEND_EMAILS) {
      try {
        await sendOrderAttestationIfNeeded(order);
        console.log(`  ↳ Confirmation envoyée: ${order.payerEmail}`);
      } catch (err) {
        console.error(`  ✉️  Échec envoi email pour ${orderId}: ${err.message}`);
      }
    }
  }

  console.log('— Résumé —');
  console.log(`Orders: created=${created} updated=${updated} skipped=${skipped}`);
  console.log(`Subscribers: upserts=${subscriberUpserts} updates=${subscriberUpdates}`);
  console.log(`Seats booked: ${bookedSeats}`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌ ERROR:', err?.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
