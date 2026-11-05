// src/services/cart-rules.js
//
// Contrôles de cohérence d'un panier, communs à tous les canaux.
//
// Déclarés dans data/customization/cart-rules.json (tableau) :
//
//   [
//     { "key": "enfant-accompagne",
//       "message": "Un tarif enfant doit être accompagné d'au moins un adulte.",
//       "channels": ["public", "partner"],
//       "when":    { "tariffs": ["ENFANT"] },
//       "require": { "tariffs": ["NORMAL", "AISC"], "min": 1 } }
//   ]
//
//   key       identifiant stable (réponses d'API, journaux) ;
//   message   texte montré à l'acheteur ;
//   channels  où la règle s'applique : "public", "partner" (tout partenaire),
//             "partner:<slug>", "all". Absent : partout ;
//   when      la règle ne joue que si le panier contient au moins une ligne
//             de ces tarifs ;
//   require   le panier doit alors contenir au moins `min` lignes (défaut 1)
//             de ces tarifs ; avec `per`, `min` lignes par tranche de `per`
//             lignes « when » (ex. per 4 : un adulte pour quatre enfants).
//
// Les codes tarif sont ceux de la grille ; une règle vaut pour toutes les
// grilles qui emploient ces codes. Appliqué au paiement côté serveur (flux
// événement aujourd'hui) et avant paiement côté panier (generic-view.js).
import fs from 'fs';
import path from 'path';

const RULES_FILE = () => path.resolve(process.cwd(), 'data', 'customization', 'cart-rules.json');

const codes = (list) => (Array.isArray(list) ? list : [])
  .map(c => String(c || '').trim().toUpperCase()).filter(Boolean);

/** Règles normalisées ; lève sur une règle mal formée, avec sa clé. */
export function normalizeCartRules(raw) {
  if (!Array.isArray(raw)) throw new Error('cart-rules.json : un tableau de règles est attendu');
  return raw.map((r, i) => {
    const key = String(r?.key || '').trim() || `regle-${i + 1}`;
    const when = codes(r?.when?.tariffs);
    const require = codes(r?.require?.tariffs);
    if (!when.length) throw new Error(`cart-rules[${key}] : when.tariffs vide`);
    if (!require.length) throw new Error(`cart-rules[${key}] : require.tariffs vide`);
    const min = r?.require?.min ?? 1;
    const per = r?.require?.per ?? null;
    if (!Number.isInteger(min) || min < 1) throw new Error(`cart-rules[${key}] : require.min doit être un entier ≥ 1`);
    if (per !== null && (!Number.isInteger(per) || per < 1)) throw new Error(`cart-rules[${key}] : require.per doit être un entier ≥ 1`);
    return {
      key,
      message: String(r?.message || `Panier incomplet : ${require.join(' ou ')} requis avec ${when.join(', ')}.`),
      channels: Array.isArray(r?.channels) && r.channels.length
        ? r.channels.map(c => String(c).trim().toLowerCase()).filter(Boolean)
        : null,
      when: { tariffs: when },
      require: { tariffs: require, min, per }
    };
  });
}

/** Règles du fichier ; [] s'il n'existe pas. Relu à chaque appel : petit fichier, modifié à chaud. */
export function loadCartRules() {
  const file = RULES_FILE();
  if (!fs.existsSync(file)) return [];
  return normalizeCartRules(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/**
 * Canal du panier : "public", ou "partner:<slug>". Une règle s'y applique si
 * elle n'a pas de `channels`, ou si l'un d'eux vaut "all", le canal exact, ou
 * "partner" pour tout partenaire.
 */
export function rulesForChannel(rules, channel) {
  const ch = String(channel || 'public').toLowerCase();
  return rules.filter(r => !r.channels
    || r.channels.includes('all')
    || r.channels.includes(ch)
    || (ch.startsWith('partner:') && r.channels.includes('partner')));
}

const lineQty = (ln) => Number(ln?.qty ?? ln?.quantity ?? 1) || 1;

/** Première règle enfreinte par le panier, ou null. */
export function cartRuleViolation(rules, lines) {
  const count = (set) => (lines || []).reduce(
    (n, ln) => n + (set.includes(String(ln?.tariffCode || '').toUpperCase()) ? lineQty(ln) : 0), 0);
  for (const r of rules) {
    const whenN = count(r.when.tariffs);
    if (!whenN) continue;
    const needed = r.require.per ? Math.ceil(whenN / r.require.per) * r.require.min : r.require.min;
    const have = count(r.require.tariffs);
    if (have < needed) {
      return { error: 'cart_rule', key: r.key, message: r.message, needed, have };
    }
  }
  return null;
}
