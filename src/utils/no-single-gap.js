// src/utils/no-single-gap.js

/**
 * Parse un seatId de type "S5-E-042" → { zoneKey:'S5', rowKey:'E', pos:42 }
 */
export function parseSeatRowPos(seatId) {
  const s = String(seatId || '');
  const m = s.match(/^([^-]+)-([A-Za-z])-(\d{2,3})$/);
  if (!m) return { zoneKey: null, rowKey: null, pos: null };
  return { zoneKey: m[1].toUpperCase(), rowKey: m[2].toUpperCase(), pos: parseInt(m[3], 10) };
}

/**
 * Détermine s'il existe un segment d'UN seul siège disponible (trou de 1)
 * dans une rangée, en se basant sur:
 * - rowSeats: positions de la rangée (triées)
 * - takenSet: positions considérées "prises" (booked/busy/unavailable + sélection courante)
 */
export function createsSingleGap(rowSeats, takenSet) {
  let runLen = 0;
  let hasSingle = false;
  const flush = () => {
    if (runLen === 1) hasSingle = true;
    runLen = 0;
  };
  for (const pos of rowSeats) {
    if (takenSet.has(pos)) {
      if (runLen > 0) flush();
    } else {
      runLen++;
    }
  }
  if (runLen > 0) flush();
  return hasSingle;
}

/**
 * seatsInRow: [{ pos, status }]
 * addPos: Set<number> positions ajoutées par l’utilisateur
 * forbidPreexistingSingles: si true, on refuse aussi si la rangée avait déjà un trou de 1
 */
export function violatesNoSingleGap(seatsInRow, addPos, forbidPreexistingSingles = false) {
  const rowSeats = seatsInRow.map(s => s.pos).sort((a, b) => a - b);
  const baseTaken = new Set(seatsInRow.filter(s => s.status !== 'available').map(s => s.pos));
  if (forbidPreexistingSingles && createsSingleGap(rowSeats, baseTaken)) {
    return true;
  }
  const takenAfter = new Set(baseTaken);
  for (const p of addPos) takenAfter.add(p);
  return createsSingleGap(rowSeats, takenAfter);
}

/**
 * Vérifie la règle anti-trou pour une sélection multi-sièges.
 * allSeats: documents Seat (au moins: { seatId, status, zoneKey })
 * selectedSeatIds: array de seatId réels (ignorer les IDs virtuels type "TBH7-Z001")
 * Retourne: { ok:true } OU { ok:false, zoneKey, rowKey }
 */
export function checkNoSingleGapForSelection(allSeats, selectedSeatIds, forbidPreexistingSingles = false) {
  // Index zone|row -> [{pos,status}]
  const byRow = new Map();
  for (const s of allSeats || []) {
    const { zoneKey, rowKey, pos } = parseSeatRowPos(s.seatId);
    if (!zoneKey || !rowKey || !pos) continue;
    const key = `${zoneKey}|${rowKey}`;
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push({ pos, status: String(s.status || 'available').toLowerCase() });
  }

  // Ajouts par rangée
  const addByRow = new Map();
  for (const sid of selectedSeatIds || []) {
    const { zoneKey, rowKey, pos } = parseSeatRowPos(sid);
    if (!zoneKey || !rowKey || !pos) continue;
    const key = `${zoneKey}|${rowKey}`;
    if (!addByRow.has(key)) addByRow.set(key, new Set());
    addByRow.get(key).add(pos);
  }

  for (const [key, addSet] of addByRow) {
    const seatsInRow = byRow.get(key) || [];
    if (!seatsInRow.length) continue;
    const violates = violatesNoSingleGap(seatsInRow, addSet, forbidPreexistingSingles);
    if (violates) {
      const [zoneKey, rowKey] = key.split('|');
      return { ok: false, zoneKey, rowKey };
    }
  }
  return { ok: true };
}
