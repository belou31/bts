// src/services/event-season-sync.js
import mongoose from 'mongoose';

import { Event } from '../models/Event.js';
import { Order } from '../models/Order.js';
import { Ticket } from '../models/Ticket.js';
import { resolveLinePlacement } from '../utils/event-attendance.js';
import { isVirtualZoneSeatId } from '../utils/seat-id.js';

const DEFAULT_PROVIDER = 'season-sync';

// Ce qui vaut abonnement à la saison, donc droit aux billets de chaque match.
// Un RENOUVELLEMENT en fait partie : c'est la façon dont un abonné existant
// reprend sa place pour la saison, pas un flux à part. Ne chercher que
// 'subscription' laissait tous les renouveleurs hors de la synchronisation —
// ils ne recevaient aucun billet. Même définition que
// utils/zone-availability.js et routes/renew.js, qui comptent déjà les deux
// flux ensemble ; 'vip' reste volontairement dehors, il n'a jamais été
// considéré comme un abonnement saison ici.
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

// Un abonné dont le placement saison a échoué (siège pris entre-temps) a bien
// payé : sa commande de match doit exister malgré tout, sinon il est le seul à
// ne recevoir ni billet ni message — la synchro ne lisant que les commandes
// 'paid', il disparaissait du circuit.
function parentSeatConflict(parentOrder) {
  const c = parentOrder?.paymentProviderMeta?.conflict;
  if (!c || String(c.kind || '') !== 'seat_conflict') return null;
  return c;
}

/**
 * Qui occupe déjà quoi sur CE match, hors commandes issues de la synchro.
 *
 * Deuxième façon de perdre sa place, distincte du conflit saison : l'abonné a
 * bien son siège pour la saison, mais quelqu'un a acheté ce même siège en
 * vente à l'unité pour ce match précis. La commande saison est parfaitement
 * saine — le heurt n'apparaît qu'ici, au moment de fabriquer la commande de
 * match. Sans ce contrôle, la synchro créait une seconde commande 'paid' sur
 * le siège : deux billets pour la même place, et deux courriels.
 *
 * On retient TOUS les revendiquants d'un siège, pas seulement le premier : la
 * commande de match issue de l'abonnement occupe elle aussi le siège une fois
 * créée, et ne garder qu'un nom pouvait ne retenir qu'elle — le heurt passait
 * alors inaperçu au passage suivant.
 *
 * @returns {Promise<Map<string, Set<string>>>} seatId -> ids des commandes qui l'occupent
 */
async function buildSeatClaims(eventDoc) {
  const claims = new Map();
  const orders = await Order.find(
    {
      status: { $in: ['paid', 'tobepaid'] },
      $or: [{ eventId: eventDoc._id }, { 'meta.eventId': String(eventDoc._id) }]
    },
    { lines: 1, parentOrderId: 1 }
  ).lean();

  for (const ord of orders) {
    for (const ln of (ord.lines || [])) {
      const placement = resolveLinePlacement(ln);
      if (placement.released) continue;
      const seatId = String(placement.seatId || '').trim();
      if (!seatId || isVirtualZoneSeatId(seatId)) continue;
      if (!claims.has(seatId)) claims.set(seatId, new Set());
      claims.get(seatId).add(String(ord._id));
    }
  }
  return claims;
}

/** Les sièges de cette commande déjà pris par QUELQU'UN D'AUTRE sur ce match. */
function contestedSeats(lines, claims, selfOrderId) {
  const out = [];
  for (const ln of (lines || [])) {
    const placement = resolveLinePlacement(ln);
    if (placement.released) continue;
    const seatId = String(placement.seatId || '').trim();
    if (!seatId || isVirtualZoneSeatId(seatId)) continue;
    const holders = claims.get(seatId);
    if (!holders) continue;
    const others = [...holders].filter(id => id !== String(selfOrderId || ''));
    if (others.length) {
      out.push({ seatId, reason: 'already_booked', heldBy: others[0] });
    }
  }
  return out;
}

/**
 * Une commande sans place ne doit porter aucun billet.
 *
 * Le modèle Ticket n'a pas d'état « annulé » et le contrôle d'accès ne relit
 * pas le statut de la commande : un billet laissé en base resterait donc
 * scannable, et deux personnes se présenteraient sur le même siège. On les
 * retire ; ils seront réémis sur la nouvelle place après le replacement.
 */
async function dropTickets(orderDoc) {
  const hadMeta = Array.isArray(orderDoc.meta?.tickets) && orderDoc.meta.tickets.length;
  if (hadMeta) {
    orderDoc.meta = { ...orderDoc.meta, tickets: [] };
    orderDoc.markModified('meta');
  }
  if (orderDoc._id) {
    await Ticket.deleteMany({ orderId: orderDoc._id }).catch(() => {});
  }
  return hadMeta;
}

// Une commande déjà replacée par l'abonné (ligne 'moved') ne doit pas
// retomber en 'torelocate' au prochain passage de la synchro.
function hasRelocatedLine(existing) {
  const lines = Array.isArray(existing?.lines) ? existing.lines : [];
  return lines.some(l => String(l?.attendance?.status || '') === 'moved');
}

function applyCommonMetadata(orderDoc, { eventDoc, parentOrder, lines, providerMeta, status = 'paid', conflict = null }) {
  orderDoc.eventId = eventDoc._id;
  orderDoc.parentOrderId = parentOrder._id;
  orderDoc.seasonCode = eventDoc.seasonCode;
  orderDoc.venueSlug = eventDoc.venueSlug;
  // Identifiant de la commande PARENT, pas son groupKey : les commandes
  // d'abonnement partagent toutes `SUBSCRIPTION-<saison>`, si bien que deux
  // abonnements d'une même personne produisaient deux commandes de match au
  // groupKey identique — ce que l'index unique `uniq_paid_per_payer`
  // (season, venue, groupKey, payerEmail, status:paid) refuse. Le lien
  // parent→enfant étant 1:1, l'id du parent est la bonne clé.
  // Le groupKey d'origine reste consultable dans paymentProviderMeta.
  orderDoc.groupKey = `EVENT-${eventDoc.slug}-${parentOrder._id}`;
  orderDoc.itemName = `EVENT_${eventDoc.slug}`;
  orderDoc.payerFirstName = parentOrder.payerFirstName || parentOrder.payer?.firstName || '';
  orderDoc.payerLastName = parentOrder.payerLastName || parentOrder.payer?.lastName || '';
  orderDoc.payerEmail = parentOrder.payerEmail || parentOrder.payer?.email || '';
  orderDoc.paymentSplit = 1;
  orderDoc.lines = lines;
  orderDoc.totalCents = lines.reduce((acc, l) => acc + Number(l.priceCents || 0), 0);
  orderDoc.status = status;
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
    seasonParentOrderId: String(parentOrder._id),
    // Ce que l'abonné doit pouvoir lire : quelle place lui manque, et pourquoi.
    ...(conflict ? { relocate: conflict } : {})
  };
  if (!conflict && orderDoc.meta?.relocate) {
    // Replacé depuis : on ne laisse pas traîner l'ancienne alerte.
    delete orderDoc.meta.relocate;
  }
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
    seasonCode: eventDoc.seasonCode,
    venueSlug: eventDoc.venueSlug,
    payerEmail: { $ne: null },
    $and: [
      {
        $or: [
          { phase: { $in: SEASON_PASS_FLOWS } },
          { 'origin.flow': { $in: SEASON_PASS_FLOWS } },
          { mailTemplateKind: { $in: SEASON_PASS_FLOWS } }
        ]
      },
      {
        $or: [
          { status: 'paid' },
          // Payé, mais le siège saison a été pris entre-temps : le paiement est
          // encaissé et la commande passe 'failed' faute de placement. Sans
          // cette branche, ces abonnés n'avaient aucune commande de match, donc
          // aucun billet ET aucun message.
          { 'paymentProviderMeta.conflict.kind': 'seat_conflict' }
        ]
      }
    ]
  };

  // Une seule lecture pour tout le match : la carte des sièges déjà occupés.
  const seatClaims = await buildSeatClaims(eventDoc);

  const cursor = Order.find(query).cursor();
  const stats = {
    scanned: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    toRelocate: 0
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

      // Deux façons distinctes de se retrouver sans place pour ce match :
      //   1. le placement SAISON a échoué (conflit porté par la commande mère)
      //   2. le siège de la saison a été vendu à l'unité pour CE match
      // Un abonné déjà replacé de lui-même conserve sa commande payée.
      const relocated = hasRelocatedLine(existing);
      const seasonConflict = parentSeatConflict(parentOrder);
      const taken = relocated ? [] : contestedSeats(lines, seatClaims, existing?._id);

      let childConflict = null;
      if (!relocated) {
        if (seasonConflict) {
          childConflict = { reason: 'season_seat_conflict', seats: seasonConflict.seats || [], detectedAt: seasonConflict.checkedAt || null };
        } else if (taken.length) {
          childConflict = { reason: 'event_seat_taken', seats: taken, detectedAt: new Date() };
        }
      }
      const childStatus = childConflict ? 'torelocate' : 'paid';

      if (!existing) {
        if (dryRun) {
          stats.created += 1;
          if (childConflict) stats.toRelocate += 1;
          log.info('[dry-run] would create event order', {
            parentOrderId: String(parentOrder._id),
            eventId: String(eventDoc._id),
            lines: lines.length,
            status: childStatus
          });
          continue;
        }

        const child = new Order();
        applyCommonMetadata(child, { eventDoc, parentOrder, lines, providerMeta, status: childStatus, conflict: childConflict });
        if (childConflict) await dropTickets(child);
        await child.save();
        stats.created += 1;
        if (childConflict) stats.toRelocate += 1;
        continue;
      }

      const beforeLines = Array.isArray(existing.lines) ? existing.lines.map(l => l.toObject ? l.toObject() : l) : [];
      const needsUpdate = !linesEqual(beforeLines, lines);

      const expectedGroupKey = `EVENT-${eventDoc.slug}-${parentOrder._id}`;
      if (!needsUpdate && existing.status === childStatus && existing.groupKey === expectedGroupKey) {
        stats.unchanged += 1;
        if (childConflict) {
          stats.toRelocate += 1;
          // Rien à mettre à jour côté lignes, mais une commande sans place ne
          // doit jamais conserver de billet scannable — y compris si elle est
          // passée 'torelocate' avant que ce nettoyage n'existe.
          if (!dryRun && await dropTickets(existing)) await existing.save();
        }
        continue;
      }

      if (dryRun) {
        stats.updated += 1;
        if (childConflict) stats.toRelocate += 1;
        log.info('[dry-run] would update event order', {
          parentOrderId: String(parentOrder._id),
          eventOrderId: String(existing._id),
          lines: lines.length,
          status: childStatus,
          ...(childConflict ? { relocate: childConflict.reason } : {})
        });
        continue;
      }

      applyCommonMetadata(existing, { eventDoc, parentOrder, lines, providerMeta, status: childStatus, conflict: childConflict });
      if (childConflict) await dropTickets(existing);
      await existing.save();
      stats.updated += 1;
      if (childConflict) stats.toRelocate += 1;
    } catch (err) {
      stats.errors += 1;
      log.error('[event-sync] failed for subscription order', String(parentOrder._id), err);
    }
  }

  return stats;
}

export default { syncSeasonOrdersToEvent };
