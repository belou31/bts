// src/utils/no-single-gap.js
// Valide qu'une sélection de sièges ne laisse PAS de "siège isolé" AU MILIEU
// d'un tronçon (même zone + même rangée). Les bords de tronçon sont autorisés.
//
// Usage:
//   const problems = await findSingleGaps({ seasonCode, venueSlug, selectedSeatIds:[...] });
//   // problems = [{ zoneKey, row, seatId }, ...]
//
// Hypothèses:
// - seatId format “ZONE-ROW-NNN” (ex: "N4-K-056")
// - “tronçon” = suite de numéros contigus existants en BD (toute discontinuité
//   dans la numérotation est considérée comme une frontière/bord acceptable)

import { Seat } from '../models/Seat.js';

function parseSeatId(sid) {
  const m = String(sid || '').match(/^([A-Z0-9]+)-([A-Z]+)-0*([0-9]+)$/i);
  if (!m) return null;
  return { zoneKey: m[1].toUpperCase(), row: m[2].toUpperCase(), num: Number(m[3]) };
}

export async function findSingleGaps({ seasonCode, venueSlug, selectedSeatIds }) {
  const selected = (selectedSeatIds || []).map(parseSeatId).filter(Boolean);
  if (!selected.length) return [];

  // Groupe la sélection par (zone|row) pour ne requêter que les rangées concernées
  const byZR = new Map(); // "ZONE|ROW" -> [{zoneKey,row,num,seatId},...]
  for (const p of selected) {
    const key = `${p.zoneKey}|${p.row}`;
    (byZR.get(key) || byZR.set(key, []).get(key)).push(p);
  }

  const problems = [];

  for (const [key, picks] of byZR.entries()) {
    const [zoneKey, row] = key.split('|');
    // Charge TOUS les sièges existants de cette zone/rangée (peut être partiel / trous)
    const docs = await Seat.find(
      {
        seasonCode, venueSlug,
        seatId: { $regex: `^${zoneKey}-${row}-\\d+$`, $options: 'i' }
      },
      { _id: 0, seatId: 1, status: 1 }
    ).lean();

    // Map + liste ordonnée par numéro
    const nodes = docs.map(d => {
      const p = parseSeatId(d.seatId);
      if (!p) return null;
      const st = String(d.status || '').toLowerCase();
      const occupiedNow = (st !== 'available'); // busy/provisioned/booked/... => occupé
      return { seatId: d.seatId, num: p.num, occupied: occupiedNow };
    }).filter(Boolean).sort((a, b) => a.num - b.num);

    if (!nodes.length) continue; // rien à valider

    // Marque la sélection courante comme "occupée après sélection"
    const selectedSet = new Set(
      picks.map(pp => `${zoneKey}-${row}-${String(pp.num).padStart(3, '0')}`)
    );
    for (const n of nodes) {
      if (selectedSet.has(n.seatId)) n.occupied = true;
    }

    // Parcourt la ligne et construit des segments d'**indisponibilité** numérique:
    // On veut détecter des segments *disponibles* de longueur 1 **à l'intérieur**
    // de deux sièges occupés contigus (numériquement).
    let segStart = -1; // début d'un segment d'AVAIL (indices)
    for (let i = 0; i <= nodes.length; i++) {
      const cur = nodes[i];               // undefined à la fin
      const prev = nodes[i - 1];
      const curAvail = cur && !cur.occupied;
      const numberingGap = !!(cur && prev && cur.num !== prev.num + 1);

      // Si on a un trou de numérotation, on flush le segment précédent car c'est une frontière
      const mustFlushForGap = numberingGap && segStart !== -1;
      const mustFlushForEnd = (!cur || !curAvail) && segStart !== -1;
      if (mustFlushForGap || mustFlushForEnd) {
        const segEnd = mustFlushForGap ? (i - 1) : (i - 1);
        const len = segEnd - segStart + 1;
        if (len === 1) {
          // Singleton: n'est problématique que s'il est *intérieur* (deux voisins occupés ET contigus)
          const leftIdx  = segStart - 1;
          const rightIdx = segEnd + 1;
          const here     = nodes[segStart];
          const leftOK   = leftIdx >= 0
                           && nodes[leftIdx].occupied
                           && nodes[leftIdx].num === here.num - 1;
          const rightOK  = rightIdx < nodes.length
                           && nodes[rightIdx].occupied
                           && nodes[rightIdx].num === here.num + 1;
          if (leftOK && rightOK) {
            problems.push({ zoneKey, row, seatId: here.seatId });
          }
        }
        segStart = -1;
      }

      // Démarre un nouveau segment après un gap ou après un siège occupé
      if (curAvail && (segStart === -1)) {
        segStart = i;
      }
    }
  }

  return problems;
}
