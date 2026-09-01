// src/services/partner-presale.js
//
// Quotas de prévente partenaire — définition unique pour les deux flux.
//
// Un partenaire peut vendre avant l'ouverture publique, dans la limite d'un
// quota déclaré dans data/customization/partners.json :
//
//   presale.events[<eventSlug>].quota    → nombre de PLACES sur un match
//   presale.seasons[<seasonCode>].quota  → nombre d'ABONNEMENTS sur une saison
//
// Les deux comptent la même chose côté consommation : une ligne de commande
// vaut une unité. Pour un événement c'est une place, pour une saison c'est un
// abonnement — un abonné occupe une ligne, qu'il ait choisi un siège nominatif
// ou une place en zone.
//
// La règle du « consommé » vit ici et nulle part ailleurs : quand elle a été
// dupliquée entre flux, les deux copies ont fini par diverger.

import { Order } from '../models/Order.js';

const num = (v) => Number(v || 0);

export function partnerEventQuota(cfg, eventSlug) {
  if (!eventSlug) return 0;
  return num(cfg?.presale?.events?.[eventSlug]?.quota);
}

export function partnerSeasonQuota(cfg, seasonCode) {
  if (!seasonCode) return 0;
  return num(cfg?.presale?.seasons?.[seasonCode]?.quota);
}

/**
 * Somme les unités déjà consommées par ce partenaire sur ce périmètre.
 * `match` cible le périmètre (eventId, ou seasonCode) ; le partenaire et les
 * statuts vivants sont ajoutés ici pour que personne ne les oublie.
 */
async function countPartnerUnits(match, partnerSlug) {
  const agg = await Order.aggregate([
    {
      $match: {
        ...match,
        'meta.partner.slug': partnerSlug,
        status: { $nin: ['canceled', 'failed'] }
      }
    },
    { $unwind: '$lines' },
    {
      $group: {
        _id: null,
        // Une ligne sans qty vaut 1 : c'est le cas de toutes les lignes
        // d'abonnement, qui n'en portent pas.
        qty: { $sum: { $ifNull: ['$lines.qty', { $ifNull: ['$lines.quantity', 1] }] } }
      }
    }
  ]);
  return agg?.[0]?.qty || 0;
}

/** null = pas de prévente partenaire ici (pas de quota déclaré). */
export async function partnerEventPresaleRemaining({ cfg, partnerSlug, event }) {
  const quota = partnerEventQuota(cfg, event?.slug);
  if (!(quota > 0)) return null;
  const used = await countPartnerUnits({ eventId: event._id }, partnerSlug || cfg?.slug);
  return Math.max(0, quota - used);
}

/** null = pas de prévente partenaire ici (pas de quota déclaré). */
export async function partnerSeasonPresaleRemaining({ cfg, partnerSlug, seasonCode }) {
  const quota = partnerSeasonQuota(cfg, seasonCode);
  if (!(quota > 0)) return null;
  // Périmètre saison : toutes les commandes d'abonnement de ce partenaire sur
  // cette saison, quel que soit le siège ou la zone choisis.
  const used = await countPartnerUnits({ seasonCode }, partnerSlug || cfg?.slug);
  return Math.max(0, quota - used);
}
