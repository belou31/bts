// scripts/lib/seat-pattern.js
//
// Compilation et diagnostic des `seatPattern` des CSV de blocage de sièges.
//
// Partagé par block-free-seats-for-season.js et block-free-seats-for-event.js :
// les deux lisaient le même gabarit CSV avec deux copies du même code, et le
// message « aucun siège trouvé » n'y disait pas POURQUOI.

/**
 * Accepte `^...$` comme `/^...$/i`. Insensible à la casse par défaut.
 */
export function compileSeatPattern(pattern) {
  const raw = String(pattern || '').trim();
  if (!raw) return null;
  const m = raw.match(/^\/(.*)\/([a-z]*)$/i);
  try {
    return m ? new RegExp(m[1], m[2]) : new RegExp(raw, 'i');
  } catch (e) {
    console.warn(`⏭️  regex invalide "${raw}" (${e?.message || e}), ligne ignorée`);
    return null;
  }
}

/**
 * Explique une correspondance vide, au lieu de la constater.
 *
 * La cause de très loin la plus fréquente est le double antislash : dans un
 * CSV, `\\d` est lu littéralement comme antislash + d, donc la regex cherche
 * un antislash dans le seatId et ne trouve jamais rien. Le gabarit de
 * référence a longtemps propagé cette forme.
 *
 * À défaut, on montre à quoi ressemblent les seatId réellement présents :
 * c'est ce qui permet de voir qu'on visait la mauvaise zone ou la mauvaise
 * rangée, sans avoir à ouvrir la base.
 */
export async function explainNoMatch({ pattern, Seat, filter, sampleSize = 6 }) {
  const raw = String(pattern || '');
  const lines = [`⚠️  Aucun siège trouvé pour seatPattern: ${raw}`];

  if (/\\\\[dwsb]/i.test(raw)) {
    const fixed = raw.replace(/\\\\([dwsb])/gi, '\\$1');
    lines.push('   → Double antislash : dans un CSV, `\\\\d` désigne un antislash suivi de « d »,');
    lines.push('     pas un chiffre. Aucun seatId ne contient d\'antislash.');
    lines.push(`   → Écrire plutôt : ${fixed}`);
  }

  try {
    const zoneMatch = raw.match(/\(([A-Z0-9|]+)\)|\^([A-Z0-9]+)-/i);
    const zoneHint = zoneMatch ? (zoneMatch[1] || zoneMatch[2] || '').split('|') : [];
    const probe = zoneHint.length
      ? { ...filter, zoneKey: { $in: zoneHint.map(z => z.toUpperCase()) } }
      : filter;
    delete probe.seatId;
    const sample = await Seat.find(probe, { _id: 0, seatId: 1 }).limit(sampleSize).lean();
    if (sample.length) {
      lines.push(`   → seatId présents ${zoneHint.length ? `dans ${zoneHint.join(', ')}` : 'dans ce périmètre'} : ${sample.map(s => s.seatId).join(', ')}`);
    } else if (zoneHint.length) {
      lines.push(`   → aucune zone ${zoneHint.join(', ')} dans ce périmètre : vérifier la clé de zone.`);
    }
  } catch { /* le diagnostic ne doit jamais faire échouer l'import */ }

  console.warn(lines.join('\n'));
}
