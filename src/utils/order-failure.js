// src/utils/order-failure.js
//
// Vocabulaire unique des causes d'échec d'une commande.
//
// `failed` était écrit depuis dix endroits, avec trois conventions : certains
// posaient `paymentProviderMeta.reason`, d'autres `conflict.kind`, ceux du flux
// bon cadeau rien du tout. Impossible de compter quoi que ce soit, et surtout
// impossible de distinguer l'échec anodin de celui où le client a payé.
//
// D'où deux champs, posés partout, en plus des champs historiques qu'on ne
// touche pas :
//   failureReason — une valeur de FAILURE_REASONS
//   failurePhase  — 'pre_payment' | 'post_payment'
//
// La PHASE est la question qui compte en exploitation : avant le paiement,
// rien n'a été encaissé et le client n'a qu'à recommencer ; après, l'argent
// est parti et la commande n'existe pas — il faut rembourser ou reloger.

export const PRE_PAYMENT = 'pre_payment';
export const POST_PAYMENT = 'post_payment';

export const FAILURE_REASONS = {
  // — Avant paiement : rien n'a été encaissé.
  PRE_HOLD_MISMATCH:      { reason: 'pre_hold_mismatch',      phase: PRE_PAYMENT },
  SEAT_HOLD_CONFLICT:     { reason: 'seat_hold_conflict',     phase: PRE_PAYMENT },
  PROVIDER_UNAVAILABLE:   { reason: 'provider_unavailable',   phase: PRE_PAYMENT },
  VOUCHER_SEAT_CONFLICT:  { reason: 'voucher_seat_conflict',  phase: PRE_PAYMENT },

  // — Au moment du paiement ou après : de l'argent a pu être encaissé.
  SEAT_CONFLICT:          { reason: 'seat_conflict',          phase: POST_PAYMENT },
  SEAT_CONFLICT_RACE:     { reason: 'seat_conflict_race',     phase: POST_PAYMENT },
  DUPLICATE_PAID_ORDER:   { reason: 'duplicate_paid_order',   phase: POST_PAYMENT },
  SAVE_FAILED:            { reason: 'save_failed',            phase: POST_PAYMENT },
  VOUCHER_FINALIZE_FAILED:{ reason: 'voucher_finalize_failed',phase: POST_PAYMENT }
};

/**
 * Les seuls champs de traçabilité, à fusionner dans un `meta` que l'appelant
 * construit déjà (cas de order-finalization.js, qui pose aussi `conflict`).
 *
 * @param {object} descriptor  une entrée de FAILURE_REASONS
 * @returns {object} { failureReason, failurePhase, failedAt }
 */
export function failureStamp(descriptor) {
  const { reason, phase } = descriptor || {};
  return {
    failureReason: reason || 'unknown',
    failurePhase: phase || POST_PAYMENT,
    failedAt: new Date()
  };
}

/**
 * Pose le statut `failed` et sa cause sur une commande, sans enregistrer :
 * l'appelant choisit quand sauver (plusieurs sites écrivent d'autres champs
 * dans la même passe).
 *
 * @param {object} order          document Order (modifié en place)
 * @param {object} descriptor     une entrée de FAILURE_REASONS
 * @param {object} [extra]        détails libres joints à la trace
 * @returns {object} la commande
 */
export function markOrderFailed(order, descriptor, extra = {}) {
  order.status = 'failed';
  order.paymentProviderMeta = {
    ...(order.paymentProviderMeta || {}),
    ...extra,
    ...failureStamp(descriptor)
  };
  return order;
}
