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
//   max      nombre fixe, ou { "attribute": "<nom> } lu dans la session
//            (cf. oidc.identity.attributes) ;
//   tariffs  codes tarif couverts. Absent : tous les tarifs.
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
      throw new Error(`entitlements[${key}] : max doit être un entier ou { "attribute": "…" }`);
    }
    return {
      key,
      label: String(r?.label || key),
      per,
      max: typeof max === 'object' ? { attribute: String(max.attribute).trim() } : max,
      tariffs: Array.isArray(r?.tariffs) && r.tariffs.length
        ? r.tariffs.map(t => String(t).trim().toUpperCase()).filter(Boolean)
        : null
    };
  });
}

/** Plafond d'un panier pour cette session ; null si l'attribut manque. */
export function resolveMax(rule, session) {
  if (typeof rule.max === 'number') return rule.max;
  const v = session?.attributes?.[rule.max.attribute];
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? null : Math.max(0, Math.floor(n));
}

export function ruleForTariff(rules, tariffCode) {
  const code = String(tariffCode || '').toUpperCase();
  return rules.find(r => !r.tariffs || r.tariffs.includes(code)) || null;
}

const lineQty = (ln) => Number(ln?.qty ?? ln?.quantity ?? 1) || 1;

/** Places par panier ; `uncovered` liste les tarifs qu'aucun panier ne couvre. */
export function tally(rules, lines) {
  const byKey = new Map(rules.map(r => [r.key, 0]));
  const uncovered = new Set();
  for (const ln of lines || []) {
    const rule = ruleForTariff(rules, ln?.tariffCode);
    if (!rule) { uncovered.add(String(ln?.tariffCode || '?').toUpperCase()); continue; }
    byKey.set(rule.key, byKey.get(rule.key) + lineQty(ln));
  }
  return { byKey, uncovered: [...uncovered] };
}

/** État des droits : ce que montre le panier et ce que vérifie le paiement. */
export function entitlementState(rules, session, usedLines) {
  const used = tally(rules, usedLines).byKey;
  return rules.map(r => {
    const max = resolveMax(r, session);
    const u = used.get(r.key) || 0;
    return {
      key: r.key,
      label: r.label,
      per: r.per,
      tariffs: r.tariffs,
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
export function cartRefusal(rules, state, cartLines) {
  const { byKey, uncovered } = tally(rules, cartLines);
  if (uncovered.length) {
    return {
      error: 'entitlement_tariff_not_covered',
      message: `Tarif hors de vos droits : ${uncovered.join(', ')}`,
      tariffs: uncovered
    };
  }
  for (const s of state) {
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
export async function linesAlreadyOrdered({ eventId, partnerSlug, subject }) {
  const orders = await Order.find({
    eventId,
    'meta.partner.slug': partnerSlug,
    'meta.partner.subject': subject,
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
export async function entitlementsForEvent({ cfg, partnerSlug, session, event }) {
  const rules = entitlementRules(cfg);
  if (!rules.length) return null;
  if (!session?.sub) {
    const err = new Error('Connexion requise pour connaître vos droits.');
    err.code = 'partner_login_required';
    throw err;
  }
  const usedLines = await linesAlreadyOrdered({ eventId: event._id, partnerSlug, subject: session.sub });
  return { rules, state: entitlementState(rules, session, usedLines) };
}
