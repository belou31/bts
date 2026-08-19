// src/services/event-season-sync.js
import mongoose from 'mongoose';

import { Event } from '../models/Event.js';
import { Order } from '../models/Order.js';

const DEFAULT_PROVIDER = 'season-sync';

// Ce qui vaut abonnement à la saison, donc droit aux billets de chaque match.
// Un RENOUVELLEMENT en fait partie : c'est la façon dont un abonné existant
// reprend sa place pour la saison, pas un flux à part. Ne chercher que
// 'subscription' laissait tous les renouveleurs hors de la synchronisation —
// ils ne recevaient aucun billet. Même définition que
// utils/zone-availability.js et routes/renew.js, qui comptent déjà les deux
// flux ensemble ; 'fanclub'/'vip' restent volontairement dehors, ils n'ont
// jamais été considérés comme des abonnements saison ici.
const SEASON_PASS_FLOWS = ['subscription', 'renew'];

function ensureLogger(logger) {
  if (logger && typeof logger.info === 'function' && typeof logger.warn === 'function') {
    return logger;
  }
  return console;
}

function normalizeId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (mongoose.Types.ObjectId.isValid(value)) return new mongoose.Types.ObjectId(value);
  return null;
}

function zoneFromSeatId(seatId) {
  const raw = String(seatId || '').trim();
  const idx = raw.indexOf('-');
  return idx > 0 ? raw.slice(0, idx).toUpperCase() : raw.toUpperCase();
}

function cloneAttendance(attendance) {
  if (!attendance) return undefined;
  const out = { ...attendance };
  if (attendance.updatedAt) {
    out.updatedAt = new Date(attendance.updatedAt);
  }
  return out;
}

function buildSourceLineId(parentOrderId, index) {
  const suffix = String(index).padStart(4, '0');
  return `${String(parentOrderId)}#${suffix}`;
}

function normalizeLineFromSubscription(parentOrder, line, index, attendanceMap) {
  const seatId = String(line?.seatId || '').trim();
  const zoneKeyRaw = String(line?.zoneKey || '').trim().toUpperCase();
  const zoneKey = zoneKeyRaw || zoneFromSeatId(seatId);
  const tariffCode = String(line?.tariffCode || '').trim().toUpperCase();
  const priceCents = Number.isFinite(Number(line?.priceCents)) ? Number(line.priceCents) : 0;
  const holderFirstName = String(line?.holderFirstName || '').trim();
  const holderLastName = String(line?.holderLastName || '').trim();
  const justif = String(line?.justif || '').trim();
  const info = String(line?.info || '').trim();
  const sourceLineId = buildSourceLineId(parentOrder._id, index);

  const attendance = cloneAttendance(attendanceMap.get(sourceLineId));

  return {
    seatId,
    zoneKey,
    tariffCode,
    priceCents,
    holderFirstName,
    holderLastName,
    justif,
    info,
    sourceLineId,
    ...(attendance ? { attendance } : {})
  };
}

function collectAttendance(existingOrder, parentOrder) {
  if (!existingOrder) return new Map();
  const map = new Map();
  const lines = Array.isArray(existingOrder.lines) ? existingOrder.lines : [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const att = line?.attendance;
    if (!att) continue;
    const sourceId = line?.sourceLineId || buildSourceLineId(parentOrder._id, i);
    if (!sourceId) continue;
    map.set(sourceId, att);
  }

  return map;
}

function linesEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] || {};
    const right = b[i] || {};
    const keys = ['seatId', 'zoneKey', 'tariffCode', 'priceCents', 'holderFirstName', 'holderLastName', 'justif', 'info', 'sourceLineId'];
    for (const key of keys) {
      if (String(left[key] ?? '') !== String(right[key] ?? '')) return false;
    }
    const leftAttendance = left.attendance || null;
    const rightAttendance = right.attendance || null;
    const attKeys = ['status', 'overrideSeatId', 'overrideZoneKey', 'note'];
    if (!!leftAttendance !== !!rightAttendance) return false;
    if (leftAttendance && rightAttendance) {
      for (const key of attKeys) {
        if (String(leftAttendance[key] ?? '') !== String(rightAttendance[key] ?? '')) return false;
      }
    }
  }
  return true;
}

function applyCommonMetadata(orderDoc, { eventDoc, parentOrder, lines, providerMeta }) {
  orderDoc.eventId = eventDoc._id;
  orderDoc.parentOrderId = parentOrder._id;
  orderDoc.seasonCode = eventDoc.seasonCode;
  orderDoc.venueSlug = eventDoc.venueSlug;
  orderDoc.groupKey = `EVENT-${eventDoc.slug}-${parentOrder.groupKey || parentOrder._id}`;
  orderDoc.itemName = `EVENT_${eventDoc.slug}`;
  orderDoc.payerFirstName = parentOrder.payerFirstName || parentOrder.payer?.firstName || '';
  orderDoc.payerLastName = parentOrder.payerLastName || parentOrder.payer?.lastName || '';
  orderDoc.payerEmail = parentOrder.payerEmail || parentOrder.payer?.email || '';
  orderDoc.paymentSplit = 1;
  orderDoc.lines = lines;
  orderDoc.totalCents = lines.reduce((acc, l) => acc + Number(l.priceCents || 0), 0);
  orderDoc.status = 'paid';
  orderDoc.paymentProvider = DEFAULT_PROVIDER;
  orderDoc.paymentProviderMeta = {
    ...(orderDoc.paymentProviderMeta || {}),
    ...providerMeta,
    name: DEFAULT_PROVIDER,
    syncedAt: new Date(),
    seasonOrderId: String(parentOrder._id)
  };
  orderDoc.origin = {
    flow: 'event',
    uiPath: '/event/import',
    apiPath: '/event/import'
  };
  orderDoc.mailTemplateKind = 'event';
  orderDoc.meta = {
    ...(orderDoc.meta || {}),
    eventId: String(eventDoc._id),
    eventSlug: eventDoc.slug,
    eventName: eventDoc.name,
    eventStartsAt: eventDoc.startsAt,
    provider: DEFAULT_PROVIDER,
    seasonParentOrderId: String(parentOrder._id)
  };
}

export async function syncSeasonOrdersToEvent({ eventId = null, eventSlug = null, dryRun = false, logger = null } = {}) {
  const log = ensureLogger(logger);
  const lookup = [];
  if (eventId) {
    const id = normalizeId(eventId);
    if (id) lookup.push({ _id: id });
  }
  if (eventSlug) {
    lookup.push({ slug: eventSlug });
  }
  if (!lookup.length) {
    throw new Error('syncSeasonOrdersToEvent: provide eventId or eventSlug');
  }

  const eventDoc = await Event.findOne({ $or: lookup });
  if (!eventDoc) {
    throw new Error('Évènement introuvable pour la synchronisation');
  }

  const query = {
    status: 'paid',
    seasonCode: eventDoc.seasonCode,
    venueSlug: eventDoc.venueSlug,
    payerEmail: { $ne: null },
    $or: [
      { phase: { $in: SEASON_PASS_FLOWS } },
      { 'origin.flow': { $in: SEASON_PASS_FLOWS } },
      { mailTemplateKind: { $in: SEASON_PASS_FLOWS } }
    ]
  };

  const cursor = Order.find(query).cursor();
  const stats = {
    scanned: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0
  };

  for await (const parentOrder of cursor) {
    stats.scanned += 1;
    try {
      const attendanceMap = new Map();
      const existing = await Order.findOne({ eventId: eventDoc._id, parentOrderId: parentOrder._id });
      if (existing) {
        collectAttendance(existing, parentOrder).forEach((value, key) => attendanceMap.set(key, value));
      }

      const parentLines = Array.isArray(parentOrder.lines) ? parentOrder.lines : [];
      if (!parentLines.length) {
        stats.skipped += 1;
        continue;
      }

      const lines = parentLines.map((line, index) =>
        normalizeLineFromSubscription(parentOrder, line, index, attendanceMap)
      );

      const providerMeta = {
        source: 'season-sync',
        originalGroupKey: parentOrder.groupKey || null,
        originalCreatedAt: parentOrder.createdAt || null
      };

      if (!existing) {
        if (dryRun) {
          stats.created += 1;
          log.info('[dry-run] would create event order', {
            parentOrderId: String(parentOrder._id),
            eventId: String(eventDoc._id),
            lines: lines.length
          });
          continue;
        }

        const child = new Order();
        applyCommonMetadata(child, { eventDoc, parentOrder, lines, providerMeta });
        await child.save();
        stats.created += 1;
        continue;
      }

      const beforeLines = Array.isArray(existing.lines) ? existing.lines.map(l => l.toObject ? l.toObject() : l) : [];
      const needsUpdate = !linesEqual(beforeLines, lines);

      if (!needsUpdate && existing.status === 'paid') {
        stats.unchanged += 1;
        continue;
      }

      if (dryRun) {
        stats.updated += 1;
        log.info('[dry-run] would update event order', {
          parentOrderId: String(parentOrder._id),
          eventOrderId: String(existing._id),
          lines: lines.length
        });
        continue;
      }

      applyCommonMetadata(existing, { eventDoc, parentOrder, lines, providerMeta });
      await existing.save();
      stats.updated += 1;
    } catch (err) {
      stats.errors += 1;
      log.error('[event-sync] failed for subscription order', String(parentOrder._id), err);
    }
  }

  return stats;
}

export default { syncSeasonOrdersToEvent };
