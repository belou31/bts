// src/services/payments/provider-error.js
//
// Erreur d'un appel au prestataire, avec son statut HTTP et ses messages.
// Sans eux, l'appelant ne distinguait pas une panne (réessayer plus tard)
// d'un refus des données de la commande (corriger puis relancer) : un nom de
// payeur refusé par HelloAsso s'affichait « prestataire indisponible ».

export function providerError(label, status, body, messages = []) {
  const err = new Error(`${label} ${status} ${JSON.stringify(body)}`);
  err.status = status;
  err.providerMessages = messages.map(m => String(m || '').trim()).filter(Boolean);
  return err;
}

/**
 * Refus des données envoyées (4xx), par opposition à une panne. Exclus :
 * authentification (401/403) et ressource introuvable (404), qui relèvent de
 * notre configuration, délai (408) et quota d'appels (429), qui sont des
 * indisponibilités.
 */
export function isProviderRejection(err) {
  const s = Number(err?.status);
  return Number.isInteger(s) && s >= 400 && s < 500 && ![401, 403, 404, 408, 429].includes(s);
}
