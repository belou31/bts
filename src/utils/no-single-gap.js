// src/utils/no-single-gap.js
import { Seat } from '../models/Seat.js';

/**
 * Règle "no single gap"
 * Interdit de laisser une place disponible isolée entre deux places occupées dans UNE même rangée.
 * - On ne bloque PAS un “trou” en bout de rangée (bords).
 * - On se base sur l'état actuel en BD (booked/busy = occupé ; available = libre),
 *   + les sièges que l'utilisateur tente d'ajouter.
 *
 * @param {Object} args
 * @param {string} args.seasonCode
 * @param {string} args.venueSlug
 * @param {string[]} args.seatIds - liste de sièges RÉELS choisis par l'utilisateur
 * @returns {null|{zoneKey,rowKey,gapSeatId,leftSeatId,rightSeatId}}
 */
export async function checkNoSingleGap({ seasonCode, venueSlug, seatIds }) {
  const list = Array.from(new Set((seatIds || []).map(s => String(s || '').trim()).filter(Boolean)));
  if (list.length <= 1) return null; // un seul siège: pas de cas "trou isolé"

  // Parseur d'ID "ZONE-ROW-NNN"
  const RE = /^([A-Z0-9]+)-([A-Z]+)-(\d+)$/i;
  const parse = (sid) => {
    const m = String(sid || '').match(RE);
    if (!m) return null;
    return {
      zoneKey: m[1].toUpperCase(),
      rowKey:  m[2].toUpperCase(),
      num:     parseInt(m[3], 10),
      pad:     m[3].length
    };
  };

  // Regrouper la sélection par (zone,row)
  const rows = new Map(); // "ZONE|ROW" -> { zoneKey,rowKey,pad, selected:Set<number> }
  for (const sid of list) {
    const p = parse(sid);
    if (!p) continue;
    const key = `${p.zoneKey}|${p.rowKey}`;
    let rec = rows.get(key);
    if (!rec) { rec = { zoneKey: p.zoneKey, rowKey: p.rowKey, pad: p.pad, selected: new Set() }; rows.set(key, rec); }
    rec.pad = Math.max(rec.pad, p.pad);
    rec.selected.add(p.num);
  }
  if (!rows.size) return null;

  // Construire une requête pour récupérer tous les sièges des rangées concernées
  const or = [];
  for (const { zoneKey, rowKey } of rows.values()) {
    // ^ZONE-ROW-\d+  (insensible à la casse)
    or.push({ seatId: new RegExp(`^${escapeReg(zoneKey)}-${escapeReg(rowKey)}-\\d+$`, 'i') });
  }
  // Rien à vérifier ?
  if (!or.length) return null;

  const dbSeats = await Seat.find(
    { seasonCode, venueSlug, $or: or },
    { _id: 0, seatId: 1, status: 1 }
  ).lean();

  // Indexer par rangée
  const rowMap = new Map(); // key -> { zoneKey,rowKey,pad, existing:Set<number>, occupied:Set<number> }
  for (const s of dbSeats || []) {
    const p = parse(s.seatId);
    if (!p) continue;
    const key = `${p.zoneKey}|${p.rowKey}`;
    let rec = rowMap.get(key);
    if (!rec) {
      const seed = rows.get(key) || { pad: p.pad };
      rec = {
        zoneKey: p.zoneKey,
        rowKey:  p.rowKey,
        pad:     Math.max(p.pad, seed.pad || 3),
        existing: new Set(),
        occupied: new Set()
      };
      rowMap.set(key, rec);
    }
    rec.pad = Math.max(rec.pad, p.pad);
    rec.existing.add(p.num);
    // Occupé si BD != available
    const st = String(s.status || '').toLowerCase();
    if (st && st !== 'available') rec.occupied.add(p.num);
  }

  // Ajouter la sélection utilisateur comme "occupé"
  for (const [key, meta] of rows.entries()) {
    const rec = rowMap.get(key);
    if (!rec) continue;
    for (const n of meta.selected) rec.occupied.add(n);
  }

  // Recherche d'un trou isolé : pattern OCCUPÉ - LIBRE - OCCUPÉ avec indices consécutifs
  for (const rec of rowMap.values()) {
    const nums = Array.from(rec.existing).sort((a, b) => a - b);
    if (nums.length < 3) continue;

    const has = (n) => rec.existing.has(n);
    const occ = (n) => rec.occupied.has(n);

    for (let i = 1; i < nums.length - 1; i++) {
      const n = nums[i];
      const l = nums[i - 1];
      const r = nums[i + 1];
      // On ne vérifie que des positions "centrales" consécutives
      if (l + 1 !== n || n + 1 !== r) continue;

      // Trou isolé = libre ET ses deux voisins présents & occupés
      if (!occ(n) && has(l) && has(r) && occ(l) && occ(r)) {
        const gapSeatId   = makeSeatId(rec.zoneKey, rec.rowKey, n, rec.pad);
        const leftSeatId  = makeSeatId(rec.zoneKey, rec.rowKey, l, rec.pad);
        const rightSeatId = makeSeatId(rec.zoneKey, rec.rowKey, r, rec.pad);
        return {
          zoneKey: rec.zoneKey,
          rowKey:  rec.rowKey,
          gapSeatId,
          leftSeatId,
          rightSeatId
        };
      }
    }
  }

  return null;
}

function escapeReg(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function makeSeatId(zoneKey, rowKey, num, pad = 3) {
  return `${zoneKey}-${rowKey}-${String(num).padStart(pad, '0')}`;
}
