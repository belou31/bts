// src/services/season-access.js
//
// Qui peut acheter un abonnement, et pourquoi — définition unique, partagée
// par la page (routes/index.js) et l'API (routes/subscription.js). Quand la
// page et l'API répondent séparément, on finit par afficher un formulaire qui
// échoue au paiement.
//
// Public     : la porte `subscribe` de la saison doit être ouverte.
// Partenaire : un quota déclaré ouvre une fenêtre d'anticipation — il vend
//              avant le public. Le quota se compte en ABONNEMENTS.
//
// Le quota reste un plafond même après l'ouverture publique : pour une saison
// il exprime une allocation contractuelle (« ce partenaire place 50
// abonnements »), pas seulement un droit d'antériorité. C'est là qu'il diffère
// du quota d'événement, qui ne borne que la prévente.

import { seasonDoorStatus, isSeasonSubscribeLocked } from '../utils/season-sale.js';
import { partnerSeasonQuota, partnerSeasonPresaleRemaining } from './partner-presale.js';

export const SEASON_ACCESS_MESSAGES = {
  season_not_found:      'Saison introuvable.',
  season_not_published:  "Cette saison n'est pas encore ouverte.",
  season_archived:       'Cette saison est archivée.',
  subscribe_notopen:     "L'abonnement n'est pas encore ouvert.",
  subscribe_closed:      "L'abonnement est clos pour cette saison.",
  partner_no_quota:      "L'abonnement n'est pas encore ouvert pour ce partenaire.",
  partner_quota_reached: "Votre quota d'abonnements est atteint."
};

export function seasonAccessMessage(reason) {
  return SEASON_ACCESS_MESSAGES[reason] || 'Abonnement indisponible.';
}

/**
 * @param {object}  season       document Season (lean ou non)
 * @param {string}  seasonCode
 * @param {object?} partnerCfg   config partenaire, ou null pour le public
 * @param {string?} partnerSlug
 * @returns {{allowed:boolean, reason:string|null, partner:object|null}}
 */
export async function resolveSeasonSubscribeAccess({ season, seasonCode, partnerCfg = null, partnerSlug = '' }) {
  if (!season) return { allowed: false, reason: 'season_not_found', partner: null };

  if (!partnerCfg) {
    const st = seasonDoorStatus(season, 'subscribe');
    return { allowed: st.open, reason: st.reason || null, partner: null };
  }

  const slug = String(partnerSlug || partnerCfg.slug || '').trim().toLowerCase();
  const quota = partnerSeasonQuota(partnerCfg, seasonCode);
  const doorOpen = seasonDoorStatus(season, 'subscribe').open;

  // Arrêt dur : une saison close ou archivée ne se vend plus, quota ou pas.
  if (isSeasonSubscribeLocked(season)) {
    return {
      allowed: false,
      reason: season.activity === 'archived' ? 'season_archived' : 'subscribe_closed',
      partner: { slug, quota, remaining: null, presale: false }
    };
  }

  // Sans quota déclaré, le partenaire n'a aucun droit propre : il suit la
  // porte publique comme n'importe quel visiteur.
  if (!(quota > 0)) {
    return {
      allowed: doorOpen,
      reason: doorOpen ? null : 'partner_no_quota',
      partner: { slug, quota: 0, remaining: null, presale: false }
    };
  }

  const remaining = await partnerSeasonPresaleRemaining({ cfg: partnerCfg, partnerSlug: slug, seasonCode });
  if ((remaining ?? 0) <= 0) {
    return {
      allowed: false,
      reason: 'partner_quota_reached',
      partner: { slug, quota, remaining: 0, presale: !doorOpen }
    };
  }

  return {
    allowed: true,
    reason: null,
    // presale = il vend avant le public ; sinon il vend en parallèle du public,
    // toujours dans la limite de son allocation.
    partner: { slug, quota, remaining, presale: !doorOpen }
  };
}
