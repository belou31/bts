// src/utils/zone-availability.js
//
// Remaining capacity for standing/general-admission zones, shared by the
// subscription and renewal flows. Both draw from the SAME zone quota, so they
// have to agree on what "used" means down to the edge cases (outstanding
// renewal claims, already-covered slots) — a second copy of this arithmetic
// that drifted would oversell the zone.

import { Order } from '../models/Order.js';
import { Seat } from '../models/Seat.js';
import { Subscriber } from '../models/Subscriber.js';
import { isVirtualZoneSeatId, zoneKeyFromSeatId } from './seat-id.js';

/**
 * Keeps only the zones allocated as a whole — the ones a booking UI should
 * offer as an "add a place" button. A zone that has individual Seat rows is
 * picked seat by seat on the plan instead, so a button for it would be a
 * second, quota-only way to buy the same inventory.
 *
 * The test is the presence of Seat documents, NOT `Zone.type`: type describes
 * physical seating character, and a zone can be `type: 'seated'` (real chairs)
 * while still being sold at zone level with no per-seat rows — see the note at
 * the top of utils/seat-id.js. Filtering on type would both hide such a zone's
 * button (leaving it unbuyable) and show one for genuinely seated tribunes.
 */
export async function selectZoneAllocatedZones({ seasonCode, venueSlug, zones }) {
  if (!Array.isArray(zones) || !zones.length) return [];
  const withSeats = await Seat.distinct('zoneKey', { seasonCode, venueSlug });
  const seated = new Set(
    withSeats.map(k => String(k || '').trim().toUpperCase()).filter(Boolean)
  );
  return zones.filter(z => !seated.has(String(z?.key || '').trim().toUpperCase()));
}

/**
 * Zone consumption = number of order lines grouped by zone. Only 'paid'
 * counts by default when authorising a sale (anti-oversell guard).
 *
 * NB: the Order model has no top-level `phase` field (it's `strict:true` and
 * only declares `origin.flow`) — matching on `phase` silently matched zero
 * documents ever, so this "used" count was always 0 regardless of real sales.
 * `origin.flow` is the real field; renewals use 'renew', fresh season
 * purchases use 'subscription' — both draw from the same zone quota, so both
 * must count here.
 */
export async function computeZoneUsageAllOrders({ seasonCode, venueSlug, zoneKeys, statusIn = ['paid'] }) {
  const baseMatch = {
    seasonCode,
    venueSlug,
    'origin.flow': { $in: ['subscription', 'renew'] },
    'lines.zoneKey': { $in: zoneKeys }
  };
  const statusMatch = (Array.isArray(statusIn) && statusIn.length)
    ? { status: { $in: statusIn } }                 // ex: ['paid']
    : { status: { $nin: ['canceled', 'failed'] } }; // fallback historique

  const rows = await Order.aggregate([
    { $match: { ...baseMatch, ...statusMatch } },
    { $unwind: '$lines' },
    { $match: { 'lines.zoneKey': { $in: zoneKeys } } },
    { $group: { _id: '$lines.zoneKey', count: { $sum: 1 }, seatIds: { $addToSet: '$lines.seatId' } } }
  ]);
  const usage = new Map();
  const coveredSeatIds = new Set();
  for (const r of rows) {
    usage.set(String(r._id || ''), Number(r.count || 0));
    for (const sid of (r.seatIds || [])) {
      if (sid) coveredSeatIds.add(String(sid));
    }
  }
  return { usage, coveredSeatIds };
}

/**
 * Standing-zone renewal claims have no Seat document to flip to
 * 'provisioned' (there's nothing per-slot to reserve), so an invited/pending
 * renewer's virtual seat (e.g. "FAN_ZONE-Z001") is otherwise invisible to the
 * quota above until they actually pay. This counts those outstanding claims
 * too, so a renewal window correctly reserves a slot ahead of payment —
 * mirroring what a provisioned real Seat already does implicitly by no longer
 * being 'available'. Claims already covered by a paid/tobepaid order
 * (coveredSeatIds) are skipped to avoid double-counting the same slot.
 */
export async function computeProvisionalZoneClaims({ seasonCode, venueSlug, zoneKeys, coveredSeatIds }) {
  const subs = await Subscriber.find(
    { seasonCode, venueSlug, status: { $nin: ['canceled', 'none'] } },
    { prefSeatId: 1 }
  ).lean();

  const covered = coveredSeatIds instanceof Set ? coveredSeatIds : new Set(coveredSeatIds || []);
  const usage = new Map();
  for (const sub of subs) {
    const seatId = String(sub.prefSeatId || '').trim();
    if (!seatId || !isVirtualZoneSeatId(seatId) || covered.has(seatId)) continue;
    const zoneKey = zoneKeyFromSeatId(seatId).toUpperCase();
    if (!zoneKeys.includes(zoneKey)) continue;
    usage.set(zoneKey, (usage.get(zoneKey) || 0) + 1);
  }
  return usage;
}

/** Remaining slots per zone key, quota taking precedence over raw capacity. */
export function remainingForZone(zone, used) {
  const quota    = Number(zone?.quota || 0);
  const capacity = Number(zone?.capacity || 0);
  const plafond  = quota > 0 ? quota : capacity;
  return plafond > 0 ? Math.max(0, plafond - used) : Math.max(0, capacity - used);
}

/**
 * Zones as the booking UIs consume them: { key, name, type, quota, capacity,
 * remaining, svgSelector }. `zones` must already be the active zone docs.
 */
export async function buildZonesWithRemaining({ seasonCode, venueSlug, zones }) {
  const zoneKeys = (zones || []).map(z => String(z.key || '').toUpperCase()).filter(Boolean);
  if (!zoneKeys.length) return [];

  const { usage, coveredSeatIds } = await computeZoneUsageAllOrders({
    seasonCode, venueSlug, zoneKeys, statusIn: ['paid']
  });
  const provisionalUsage = await computeProvisionalZoneClaims({
    seasonCode, venueSlug, zoneKeys, coveredSeatIds
  });

  return (zones || []).map((z) => {
    const used = (usage.get(z.key) || 0) + (provisionalUsage.get(z.key) || 0);
    return {
      key: z.key,
      name: z.name || z.key,
      type: z.type || 'public',
      quota: Number(z.quota || 0),
      capacity: Number(z.capacity || 0),
      remaining: remainingForZone(z, used),
      svgSelector: z.svgSelector || null
    };
  });
}
