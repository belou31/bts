// src/utils/event-attendance.js

/**
 * Returns the attendance payload if present and well-formed.
 * @param {object} line
 * @returns {object|null}
 */
export function getAttendance(line = null) {
  if (!line || typeof line !== 'object') return null;
  const value = line.attendance;
  if (!value || typeof value !== 'object') return null;
  return value;
}

/**
 * Computes the effective placement for a line, accounting for overrides.
 * @param {object} line
 * @returns {{ seatId: string, zoneKey: string, released: boolean, moved: boolean }}
 */
export function resolveLinePlacement(line = null) {
  const attendance = getAttendance(line);
  const baseSeat = String(line?.seatId || '').trim();
  const baseZone = String(line?.zoneKey || '').trim().toUpperCase();

  if (!attendance) {
    return {
      seatId: baseSeat,
      zoneKey: baseZone,
      released: false,
      moved: false
    };
  }

  const status = String(attendance.status || 'kept').toLowerCase();
  const overrideSeat = String(attendance.overrideSeatId || '').trim();
  const overrideZone = String(attendance.overrideZoneKey || '').trim().toUpperCase();

  if (status === 'released') {
    return {
      seatId: '',
      zoneKey: overrideZone || baseZone,
      released: true,
      moved: false
    };
  }

  if (status === 'moved') {
    return {
      seatId: overrideSeat || '',
      zoneKey: overrideZone || baseZone,
      released: false,
      moved: true
    };
  }

  return {
    seatId: baseSeat,
    zoneKey: baseZone,
    released: false,
    moved: false
  };
}

/**
 * Returns true when the line is marked as released for the event.
 * @param {object} line
 */
export function isReleased(line = null) {
  const attendance = getAttendance(line);
  if (!attendance) return false;
  return String(attendance.status || '').toLowerCase() === 'released';
}

/**
 * Returns true when the line is marked as moved for the event.
 * @param {object} line
 */
export function isMoved(line = null) {
  const attendance = getAttendance(line);
  if (!attendance) return false;
  return String(attendance.status || '').toLowerCase() === 'moved';
}

/**
 * Updates the attendance payload with helper defaults.
 * @param {object} line
 * @param {object} patch
 * @param {Date|string|null} [when]
 * @param {string} [by]
 * @returns {object}
 */
export function applyAttendancePatch(line = null, patch = {}, when = null, by = '') {
  const updatedAt = when instanceof Date ? when : (when ? new Date(when) : new Date());
  const attendance = {
    status: 'kept',
    overrideSeatId: '',
    overrideZoneKey: '',
    note: '',
    updatedAt,
    updatedBy: String(by || '')
  };

  const current = getAttendance(line);
  if (current) {
    Object.assign(attendance, current);
  }

  Object.assign(attendance, patch, { updatedAt, updatedBy: String(by || attendance.updatedBy || '') });
  return attendance;
}

export function summarizeAttendance(lines = []) {
  const summary = { kept: 0, released: 0, moved: 0 };
  for (const line of lines) {
    const attendance = getAttendance(line);
    const status = attendance ? String(attendance.status || 'kept').toLowerCase() : 'kept';
    if (status === 'released') summary.released += 1;
    else if (status === 'moved') summary.moved += 1;
    else summary.kept += 1;
  }
  return summary;
}
