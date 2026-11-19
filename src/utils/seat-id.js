// src/utils/seat-id.js
//
// Single source of truth for classifying a booking unit (an Order line or a
// Ticket) by ALLOCATION MECHANISM: individually locked against the `Seat`
// collection ('seat') vs tracked via zone-level quota scanning ('zone').
// This is deliberately independent of whether the zone physically has
// chairs — a VIP zone can be `Zone.type === 'seated'` (real chairs) while
// still being allocated at the zone level (no discrete SeatCatalog rows),
// exactly like a standing/general-admission zone is. Use `zoneType` (see
// below) for anything about physical seating character — never infer it
// from `unitType`.
//
// Historically this classification was re-derived independently in twelve
// different files by pattern-matching the seatId string shape, using two
// small regexes that had already drifted out of sync with each other and
// with what the ticket-issuance code actually generates (see git history —
// isVirtualZoneSeatId expected an "-Z###" suffix, e.g. "DEBOUT-Z001", but
// the event-checkout synthetic-seat generator produces
// "<ZONE>-GA-<suffix>-<index>" instead — two independent conventions for
// the same concept).
//
// New code should prefer the explicit `unitType` field, set once at booking
// time. The regex helpers below remain as a fallback for Order lines/Tickets
// created before that field existed.

export const isRealSeatId = (sid) => /^[A-Z0-9]+-[A-Z]+-\d{1,4}$/i.test(String(sid || ''));
export const isVirtualZoneSeatId = (sid) => /^.+-Z\d{3,}$/i.test(String(sid || ''));

export function zoneKeyFromSeatId(seatId) {
  const raw = String(seatId || '').trim();
  if (!raw) return '';
  const idx = raw.indexOf('-');
  return (idx === -1 ? raw : raw.slice(0, idx)).toUpperCase();
}

/**
 * Resolves whether a booking unit is individually seat-locked or
 * zone-quota-tracked. Prefers `unitType` when it's already one of the two
 * known values; falls back to seatId-shape heuristics for records
 * predating that field.
 * @param {{ unitType?: string, seatId?: string }} unit
 * @returns {'seat'|'zone'}
 */
export function resolveUnitType(unit = {}) {
  const explicit = String(unit?.unitType || '').toLowerCase();
  if (explicit === 'seat' || explicit === 'zone') return explicit;
  const seatId = String(unit?.seatId || '').trim();
  if (!seatId) return 'zone';
  if (!isRealSeatId(seatId) || isVirtualZoneSeatId(seatId)) return 'zone';
  return 'seat';
}

export const isSeatUnit = (unit) => resolveUnitType(unit) === 'seat';
export const isZoneUnit = (unit) => resolveUnitType(unit) === 'zone';
