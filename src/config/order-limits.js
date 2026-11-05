// src/config/order-limits.js
//
// Plafond du nombre de places par commande.
//
// Jusqu'ici aucun flux en libre-service n'en avait : hors contraintes
// indirectes (sièges disponibles, quota d'un partenaire, solde d'un bon), rien
// n'empêchait un panier de cent places. Ce plafond trace la frontière entre un
// achat individuel et un groupe, ce dernier relevant d'un traitement dédié qui
// reste à écrire.
//
// ORDER_MAX_ITEMS fixe la valeur. `0` désactive le plafond — échappatoire
// explicite, à n'employer qu'en connaissance de cause, et non un défaut.
//
// Relu à chaque appel plutôt que figé à l'import : les harnais de test
// positionnent la variable d'environnement avant d'appeler, et un défaut mis en
// cache rendrait leurs cas inopérants sans le dire.

export const ORDER_MAX_ITEMS_DEFAULT = 19;

let warned = false;

/** Plafond effectif ; 0 = aucun. */
export function orderMaxItems() {
  const raw = String(process.env.ORDER_MAX_ITEMS ?? '').trim();
  if (!raw) return ORDER_MAX_ITEMS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    // Une valeur illisible ne doit pas se traduire par « pas de limite » en
    // silence : on le dit, et on retient le défaut.
    if (!warned) {
      warned = true;
      console.warn(
        `[order-limits] ORDER_MAX_ITEMS="${raw}" illisible (entier >= 0 attendu) ;`
        + ` plafond ramené à ${ORDER_MAX_ITEMS_DEFAULT}.`
      );
    }
    return ORDER_MAX_ITEMS_DEFAULT;
  }
  return n;
}

/**
 * Nombre de places d'un panier ou d'une commande.
 *
 * Une ligne vaut une place dans tous les flux actuels, y compris en zone. Le
 * repli sur `qty`/`quantity` couvre les commandes importées, qui en portent
 * parfois une — c'est le même décompte qu'ailleurs dans le code.
 */
export function countPlaces(lines) {
  if (!Array.isArray(lines)) return 0;
  return lines.reduce((sum, ln) => sum + Number(ln?.qty ?? ln?.quantity ?? 1), 0);
}

/**
 * `null` si le panier passe, sinon le corps de refus à renvoyer tel quel.
 *
 * Rend un objet plutôt qu'un booléen pour que le code appelant n'ait pas à
 * reformuler le message : une limite énoncée de deux façons différentes selon
 * le flux est une limite que le support ne sait plus expliquer.
 */
export function orderItemsRefusal(asked) {
  const max = orderMaxItems();
  const n = Number(asked) || 0;
  if (!max || n <= max) return null;
  return {
    error: 'too_many_items',
    max,
    asked: n,
    message: `Cette commande porte ${n} places, au-delà du maximum de ${max} `
      + 'par commande. Pour un groupe de cette taille, contactez-nous.'
  };
}

/**
 * Maximum effectif quand un flux porte déjà son propre plafond — `maxPlaces`
 * de la vente de bons, par exemple.
 *
 * On retient le plus bas des deux : deux réglages qui se contredisent doivent
 * se résoudre du côté prudent, et non selon lequel est lu en dernier.
 */
export function effectiveMaxPlaces(flowMax) {
  const own = Number(flowMax);
  const hard = orderMaxItems();
  if (!Number.isFinite(own) || own <= 0) return hard;
  return hard ? Math.min(own, hard) : own;
}

/**
 * Variante à lever, pour les flux dont la validation passe déjà par une
 * exception. `err.refusal` porte le corps, que la route renvoie en 400.
 */
export function assertOrderItemCount(asked) {
  const refusal = orderItemsRefusal(asked);
  if (!refusal) return;
  const err = new Error(refusal.message);
  err.refusal = refusal;
  throw err;
}
