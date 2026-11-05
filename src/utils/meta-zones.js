// src/utils/meta-zones.js
//
// Méta-zones tarifaires : plusieurs zones au même prix partagent une étiquette
// (`Zone.metaZone`), et une grille peut être écrite une seule fois pour la
// méta-zone plutôt que recopiée zone par zone.
//
// Le dépliage se fait AU CHARGEMENT, pas au moment de lire un prix : tout le
// reste de la chaîne (index de prix serveur, `buildAllowedFromPrices`, et le
// payload envoyé au navigateur, qui déduit les zones achetables des prix)
// continue de voir une simple liste de lignes par zone. C'est ce qui permet
// d'introduire les méta-zones sans toucher au front ni aux tunnels d'achat.
//
// Une zone ajoutée plus tard à une méta-zone hérite automatiquement du prix :
// le dépliage lit les zones vivantes à chaque chargement.

import { Zone } from '../models/Zone.js';

const up = (v) => String(v || '').trim().toUpperCase();
const cell = (zoneKey, tariffCode) => `${up(zoneKey)}|${up(tariffCode)}`;

/**
 * Déplie les lignes « méta-zone » en lignes par zone.
 *
 * Une ligne visant explicitement une zone l'emporte toujours sur la méta-zone :
 * c'est ce qui permet de tarifer une méta-zone entière puis d'excepter une
 * zone, sans avoir à sortir cette zone de sa méta-zone.
 *
 * @param {Array} prices  lignes TariffPrice brutes
 * @param {Array} zones   zones de la saison/lieu ({ key, metaZone })
 * @returns {Array} lignes effectives, toutes portées par une zone
 */
export function expandMetaZonePrices(prices, zones) {
  const rows = Array.isArray(prices) ? prices : [];
  const hasMetaZoneRow = rows.some(p => up(p?.metaZone));
  if (!hasMetaZoneRow) return rows;   // rien à déplier : cas de très loin le plus courant

  const zonesByMetaZone = new Map();
  for (const z of (zones || [])) {
    const cat = up(z?.metaZone);
    if (!cat) continue;
    if (!zonesByMetaZone.has(cat)) zonesByMetaZone.set(cat, []);
    zonesByMetaZone.get(cat).push(up(z.key));
  }

  const out = [];
  const explicit = new Set();
  for (const p of rows) {
    if (up(p?.metaZone)) continue;          // traitée au second passage
    out.push(p);
    explicit.add(cell(p?.zoneKey, p?.tariffCode));
  }

  const orphans = new Set();
  for (const p of rows) {
    const cat = up(p?.metaZone);
    if (!cat) continue;
    const targets = zonesByMetaZone.get(cat) || [];
    // Une grille écrite pour une méta-zone qu'aucune zone ne porte ne produit
    // AUCUNE ligne : la zone se retrouve sans prix, le tarif disparaît ensuite
    // du filtre par canal (« garder les tarifs ayant au moins un prix »), et
    // l'acheteur voit un siège sans tarif. Le silence rendait ce cas très
    // difficile à diagnostiquer — le plus souvent, la méta-zone est posée sur
    // le catalogue du lieu sans avoir été propagée aux zones de la saison.
    if (!targets.length) {
      orphans.add(cat);
      continue;
    }
    for (const zoneKey of targets) {
      if (explicit.has(cell(zoneKey, p?.tariffCode))) continue;   // la zone prime
      const materialized = (typeof p.toObject === 'function') ? p.toObject() : { ...p };
      materialized.zoneKey = zoneKey;
      // Trace de provenance : utile pour comprendre un prix affiché sans avoir
      // à rejouer le dépliage à la main.
      materialized.fromMetaZone = cat;
      out.push(materialized);
    }
  }

  if (orphans.size) {
    console.warn(
      `[meta-zones] Grille ignorée : aucune zone ne porte ${[...orphans].join(', ')}. `
      + 'Ces zones resteront sans tarif. Vérifier Zone.metaZone pour la saison '
      + '(set-zone-meta.js --venue=<lieu> --list --season=<code>).'
    );
  }
  return out;
}

/**
 * Variante qui va chercher les zones elle-même — la forme utilisée par les
 * routes, qui n'ont pas toujours les zones sous la main.
 */
export async function withMetaZonePrices(prices, { seasonCode, venueSlug } = {}) {
  const rows = Array.isArray(prices) ? prices : [];
  if (!rows.some(p => up(p?.metaZone))) return rows;   // pas de requête inutile
  const zones = await Zone.find(
    { seasonCode, venueSlug },
    { key: 1, metaZone: 1, _id: 0 }
  ).lean().catch(() => []);
  return expandMetaZonePrices(rows, zones);
}

/** Les méta-zones réellement utilisées par les zones d'une saison/lieu. */
export async function listMetaZones({ seasonCode, venueSlug }) {
  const zones = await Zone.find(
    { seasonCode, venueSlug },
    { key: 1, name: 1, metaZone: 1, _id: 0 }
  ).lean().catch(() => []);
  const byMetaZone = new Map();
  for (const z of zones) {
    const cat = up(z.metaZone);
    if (!cat) continue;
    if (!byMetaZone.has(cat)) byMetaZone.set(cat, []);
    byMetaZone.get(cat).push({ key: up(z.key), name: z.name || z.key });
  }
  return Array.from(byMetaZone.entries())
    .map(([key, zonesInMetaZone]) => ({ key, zones: zonesInMetaZone }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
