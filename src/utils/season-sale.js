// src/utils/season-sale.js
//
// Cycle de vie d'une saison, pendant de utils/event-sale.js.
//
// Une saison a plusieurs portes de vente (renouvellement, abonnement public)
// qui ne s'ouvrent ni ne se ferment ensemble — fermer le renouvellement
// pendant que la vente publique tourne est le cas courant. Chaque porte a donc
// son propre état, plutôt qu'un unique état ordonné dont il faudrait déduire
// ce qui est ouvert.

export const ACTIVITY_STATES = ['draft', 'active', 'archived'];
export const DOOR_STATES = ['notopen', 'open', 'closed'];
export const SEASON_DOORS = ['renew', 'subscribe'];

/**
 * Une porte n'est ouverte que si la saison est publiée ET la porte ouverte :
 * `activity` couvre toute la saison d'un coup (retirer une saison de la vente
 * sans avoir à refermer chaque porte une par une).
 */
export function isSeasonDoorOpen(season, door) {
  if (!season) return false;
  if ((season.activity || 'draft') !== 'active') return false;
  return (season[door] || 'notopen') === 'open';
}

/** Pourquoi une porte est fermée — pour un message honnête plutôt qu'un 404. */
export function seasonDoorStatus(season, door) {
  if (!season) return { open: false, reason: 'season_not_found' };
  const activity = season.activity || 'draft';
  if (activity === 'archived') return { open: false, reason: 'season_archived' };
  if (activity !== 'active') return { open: false, reason: 'season_not_published' };
  const state = season[door] || 'notopen';
  if (state === 'open') return { open: true };
  return { open: false, reason: state === 'closed' ? `${door}_closed` : `${door}_notopen` };
}

/**
 * Arrêt dur : aucun chemin d'achat ne doit passer outre, quota partenaire
 * compris. Pendant de isEventSaleLocked() côté événement.
 *
 * `notopen` n'en fait volontairement pas partie : c'est précisément la fenêtre
 * d'anticipation pendant laquelle un partenaire vend avant le public. Une
 * saison `closed` ou `archived`, elle, ne se vend plus à personne.
 */
export function isSeasonSubscribeLocked(season) {
  if (!season) return true;
  if ((season.activity || 'draft') === 'archived') return true;
  return (season.subscribe || 'notopen') === 'closed';
}
