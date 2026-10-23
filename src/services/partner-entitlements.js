// src/services/partner-entitlements.js
//
// Droits d'achat d'un bénéficiaire connecté par OpenID, par partenaire.
//
// Déclarés dans data/customization/partners.json, au niveau du partenaire :
//
//   "entitlements": [
//     { "key": "ayants-droit", "label": "Places ayants droit", "per": "event",
//       "max": { "attribute": "beneficiaries" } }
//   ]
//
// Chaque entrée est un « panier de droits » :
//   key      identifiant stable (rapports, messages) ;
//   label    libellé montré à l'acheteur ;
//   per      période de décompte — seul "event" existe (par match) ;
//   max      nombre fixe, ou { "attribute": "<nom>", "default": n } lu dans
//            la session (oidc.identity.attributes, ou colonne de l'annuaire).
//            `default` (facultatif) sert quand l'ayant droit n'a pas de valeur ;
//            sans lui, une valeur absente refuse le panier ;
//   tariffs  codes tarif couverts. Absent : tous les tarifs.
//   tariffChannel  "partner" | "public" : ne couvre que les tarifs propres au
//            partenaire, ou que les tarifs publics (allowPublicTariffs) —
//            plutôt qu'une liste de codes, qui change d'une grille à l'autre ;
//   icon     pictogramme affiché après le décompte (ex. "❤️") ;
//   shortLabel  libellé court du résumé du panneau Contact (ex. « ayants
//            droit », « extra (tarif public) ») ; absent : `label` ;
//   limitDuring  états de vente où `max` s'applique (ex. ["presale"]). Hors de
//            ces états, le panier n'a PAS de limite : places « en plus » au
//            tarif public bornées en prévente, libres à l'ouverture publique.
//
// Une ligne de panier relève du PREMIER panier qui couvre son tarif. Une ligne
// qu'aucun panier ne couvre est refusée : un tarif oublié dans la
// configuration ne doit pas devenir un achat sans limite.
//
// Évolutions prévues sans changer la forme : un panier par catégorie
// (adultes, ados, enfants : tarifs et attribut propres), un panier
// « places en plus » au tarif public avec un max fixe.
import { Order } from '../models/Order.js';

const PERIODS = ['event'];
const TARIFF_CHANNELS = ['partner', 'public'];
const SALE_STATES = ['notopen', 'presale', 'onsale', 'soldout', 'closed'];

/** Règles normalisées du partenaire ; [] s'il n'en déclare aucune. */
export function entitlementRules(cfg) {
  const raw = Array.isArray(cfg?.entitlements) ? cfg.entitlements : [];
  return raw.map((r, i) => {
    const key = String(r?.key || '').trim() || `droit-${i + 1}`;
    const per = String(r?.per || 'event').trim();
    if (!PERIODS.includes(per)) {
      throw new Error(`entitlements[${key}] : per « ${per} » non pris en charge (attendu : ${PERIODS.join(', ')})`);
    }
    const max = r?.max;
    const validMax = Number.isInteger(max) && max >= 0
      || (max && typeof max === 'object' && String(max.attribute || '').trim());
    if (!validMax) {
      throw new Error(`entitlements[${key}] : max doit être un entier ou { "attribute": "…", "default": n }`);
    }
    const hasDefault = max && typeof max === 'object' && max.default !== undefined;
    if (hasDefault && !(Number.isInteger(max.default) && max.default >= 0)) {
      throw new Error(`entitlements[${key}] : max.default doit être un entier ≥ 0`);
    }
    const tariffChannel = r?.tariffChannel ? String(r.tariffChannel).trim() : null;
    if (tariffChannel && !TARIFF_CHANNELS.includes(tariffChannel)) {
      throw new Error(`entitlements[${key}] : tariffChannel « ${tariffChannel} » inconnu (attendu : ${TARIFF_CHANNELS.join(', ')})`);
    }
    const limitDuring = Array.isArray(r?.limitDuring) && r.limitDuring.length
      ? r.limitDuring.map(x => String(x).trim())
      : null;
    const badState = (limitDuring || []).find(x => !SALE_STATES.includes(x));
    if (badState) {
      throw new Error(`entitlements[${key}] : limitDuring « ${badState} » inconnu (attendu : ${SALE_STATES.join(', ')})`);
    }
    return {
      key,
      label: String(r?.label || key),
      per,
      max: typeof max === 'object'
        ? { attribute: String(max.attribute).trim(), ...(hasDefault ? { default: max.default } : {}) }
        : max,
      tariffs: Array.isArray(r?.tariffs) && r.tariffs.length
        ? r.tariffs.map(t => String(t).trim().toUpperCase()).filter(Boolean)
        : null,
      tariffChannel,
      limitDuring,
      icon: r?.icon ? String(r.icon).trim() : null,
      shortLabel: r?.shortLabel ? String(r.shortLabel).trim() : null
    };
  });
}

/**
 * Plafond d'un panier pour cette session ; null si l'attribut manque,
 * Infinity hors des états de vente de `limitDuring`.
 */
export function resolveMax(rule, session, ctx = {}) {
  if (rule.limitDuring && !rule.limitDuring.includes(String(ctx.sale || ''))) return Infinity;
  if (typeof rule.max === 'number') return rule.max;
  const v = session?.attributes?.[rule.max.attribute];
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) {
    // Valeur propre à l'ayant droit absente : le défaut du panier s'il en a un.
    return rule.max.default !== undefined ? rule.max.default : null;
  }
  return Math.max(0, Math.floor(n));
}

/**
 * `ctx.tariffChannels` : Map code → "partner" | "public", d'après la grille
 * proposée au partenaire (cf. event-flow.factory.js).
 */
export function ruleForTariff(rules, tariffCode, ctx = {}) {
  const code = String(tariffCode || '').toUpperCase();
  const channel = ctx.tariffChannels?.get?.(code) || null;
  return rules.find(r =>
    (!r.tariffs || r.tariffs.includes(code))
    && (!r.tariffChannel || r.tariffChannel === channel)
  ) || null;
}

const lineQty = (ln) => Number(ln?.qty ?? ln?.quantity ?? 1) || 1;

/** Places par panier ; `uncovered` liste les tarifs qu'aucun panier ne couvre. */
export function tally(rules, lines, ctx = {}) {
  const byKey = new Map(rules.map(r => [r.key, 0]));
  const uncovered = new Set();
  for (const ln of lines || []) {
    const rule = ruleForTariff(rules, ln?.tariffCode, ctx);
    if (!rule) { uncovered.add(String(ln?.tariffCode || '?').toUpperCase()); continue; }
    byKey.set(rule.key, byKey.get(rule.key) + lineQty(ln));
  }
  return { byKey, uncovered: [...uncovered] };
}

/** État des droits : ce que montre le panier et ce que vérifie le paiement. */
export function entitlementState(rules, session, usedLines, ctx = {}) {
  const used = tally(rules, usedLines, ctx).byKey;
  return rules.map(r => {
    const max = resolveMax(r, session, ctx);
    const u = used.get(r.key) || 0;
    // Sans limite dans cet état de vente : max / remaining à null (JSON ne
    // connaît pas Infinity), `unlimited` le dit.
    if (max === Infinity) {
      return {
        key: r.key, label: r.label, shortLabel: r.shortLabel, icon: r.icon, per: r.per, tariffs: r.tariffs, tariffChannel: r.tariffChannel,
        max: null, used: u, remaining: null, unlimited: true
      };
    }
    return {
      key: r.key,
      label: r.label,
      shortLabel: r.shortLabel,
      icon: r.icon,
      per: r.per,
      tariffs: r.tariffs,
      tariffChannel: r.tariffChannel,
      max,
      used: u,
      remaining: max === null ? 0 : Math.max(0, max - u),
      // Attribut absent de l'identité reçue : on refuse plutôt que de
      // supposer un droit.
      ...(max === null ? { unavailable: 'attribute_missing', attribute: r.max.attribute } : {})
    };
  });
}

/** null si le panier tient dans les droits, sinon le refus à renvoyer. */
export function cartRefusal(rules, state, cartLines, ctx = {}) {
  const { byKey, uncovered } = tally(rules, cartLines, ctx);
  if (uncovered.length) {
    return {
      error: 'entitlement_tariff_not_covered',
      message: `Tarif hors de vos droits : ${uncovered.join(', ')}`,
      tariffs: uncovered
    };
  }
  for (const s of state) {
    if (s.unlimited) continue;
    const asked = byKey.get(s.key) || 0;
    if (asked > s.remaining) {
      return {
        error: 'entitlement_exceeded',
        key: s.key,
        remaining: s.remaining,
        message: s.unavailable
          ? `${s.label} : droit indisponible (information « ${s.attribute} » non transmise par votre organisme).`
          : `${s.label} : ${asked} place(s) demandée(s), ${s.remaining} restante(s) sur ${s.max}.`
      };
    }
  }
  return null;
}

/** Lignes déjà engagées par ce bénéficiaire sur ce match, chez ce partenaire. */
export async function linesAlreadyOrdered({ eventId, partnerSlug, identifier }) {
  const orders = await Order.find({
    eventId,
    'meta.partner.slug': partnerSlug,
    'meta.partner.identifier': identifier,
    // Même périmètre que le quota partenaire : une commande en attente de
    // paiement compte, une annulée ou échouée non.
    status: { $nin: ['canceled', 'failed'] }
  }, { lines: 1 }).lean();
  return orders.flatMap(o => Array.isArray(o.lines) ? o.lines : []);
}

/**
 * Droits du bénéficiaire connecté pour ce match ; null si le partenaire n'en
 * déclare pas. Sans session, lève : des droits ne se calculent pas pour un
 * inconnu.
 */
export async function entitlementsForEvent({ cfg, partnerSlug, session, event, tariffChannels = null }) {
  const rules = entitlementRules(cfg);
  if (!rules.length) return null;
  if (!session?.sub) {
    const err = new Error('Connexion requise pour connaître vos droits.');
    err.code = 'partner_login_required';
    throw err;
  }
  const usedLines = await linesAlreadyOrdered({ eventId: event._id, partnerSlug, identifier: session.sub });
  const ctx = { tariffChannels: tariffChannels || new Map(), sale: event?.sale };
  return { rules, ctx, state: entitlementState(rules, session, usedLines, ctx) };
}
