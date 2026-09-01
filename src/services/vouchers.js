// src/services/vouchers.js
//
// Règles métier des bons cadeaux : jeton, éligibilité des matchs, périmètre de
// placement, et retrait (création des billets). Les routes ne font qu'appeler
// ces fonctions, pour que le guichet, l'admin et la page publique jugent un bon
// exactement de la même façon.

import jwt from 'jsonwebtoken';

import { Event } from '../models/Event.js';
import { Zone } from '../models/Zone.js';
import { Voucher } from '../models/Voucher.js';

const TOKEN_KIND = 'voucher';

// Lu à l'appel : les scripts CLI chargent dotenv dans leur corps, donc APRÈS
// l'évaluation des imports ESM (même piège que seat-change.js).
const jwtSecret = () => process.env.JWT_SECRET;

export function signVoucherToken(code, { expiresAt = null } = {}) {
  const secret = jwtSecret();
  if (!secret) throw new Error('JWT_SECRET manquant');
  const payload = { kind: TOKEN_KIND, code: String(code || '').toUpperCase() };
  // Le JWT n'expire jamais avant le bon lui-même : c'est le document qui fait
  // foi (il peut être prolongé après impression, ce qu'un exp figé interdirait).
  const opts = expiresAt ? { expiresIn: Math.max(60, Math.floor((new Date(expiresAt) - Date.now()) / 1000) + 86400) } : {};
  return jwt.sign(payload, secret, opts);
}

export function decodeVoucherToken(id) {
  const secret = jwtSecret();
  if (!id || !secret) return null;
  try {
    const tok = jwt.verify(id, secret);
    return tok?.kind === TOKEN_KIND && tok.code ? tok : null;
  } catch {
    return null;
  }
}

export function remainingOf(voucher) {
  return Math.max(0, Number(voucher?.balance?.total || 0) - Number(voucher?.balance?.used || 0));
}

/**
 * Pourquoi un bon est (ou n'est pas) utilisable, indépendamment d'un match.
 * @returns {{ok: boolean, reason?: string}}
 */
export function voucherUsability(voucher) {
  if (!voucher) return { ok: false, reason: 'voucher_not_found' };
  if (voucher.status === 'canceled') return { ok: false, reason: 'voucher_canceled' };
  if (voucher.status === 'suspended') return { ok: false, reason: 'voucher_suspended' };
  if (voucher.expiresAt && Date.now() >= new Date(voucher.expiresAt).getTime()) {
    return { ok: false, reason: 'voucher_expired' };
  }
  if (remainingOf(voucher) <= 0) return { ok: false, reason: 'voucher_spent' };
  return { ok: true };
}

/**
 * Périmètre de placement d'un bon (Q3).
 *
 * `allowedZones` contient aujourd'hui des clés de zone. Le jour où les zones
 * porteront une méta-zone (plusieurs zones au même prix, cf. le
 * chantier « méta-zones »), il suffira qu'elles exposent ce champ : une entrée
 * qui ne correspond à aucune clé de zone est déjà traitée ici comme une
 * ÉTIQUETTE et étendue aux zones qui la portent. Les bons déjà imprimés
 * continueront de fonctionner sans reprise.
 *
 * @returns {Promise<Set<string>|null>} null = aucune restriction
 */
export async function resolveAllowedZoneKeys(voucher, { seasonCode, venueSlug }) {
  const wanted = (voucher?.allowedZones || []).map(z => String(z || '').trim().toUpperCase()).filter(Boolean);
  if (!wanted.length) return null;

  const zones = await Zone.find({ seasonCode, venueSlug }, { key: 1, metaZone: 1, tags: 1, _id: 0 }).lean();
  const byKey = new Set(zones.map(z => String(z.key || '').toUpperCase()));

  const out = new Set();
  for (const entry of wanted) {
    if (byKey.has(entry)) { out.add(entry); continue; }
    // Pas une zone connue → traité comme méta-zone.
    for (const z of zones) {
      const cat = String(z.metaZone || '').toUpperCase();
      const tags = (z.tags || []).map(t => String(t || '').toUpperCase());
      if (cat === entry || tags.includes(entry)) out.add(String(z.key || '').toUpperCase());
    }
  }
  return out;
}

/** Mongo filter des évènements éligibles : les règles cadrent, la liste restreint. */
export function eligibleEventFilter(voucher) {
  const rules = voucher?.eligibility?.rules || {};
  const filter = {};

  if (Array.isArray(rules.seasonCodes) && rules.seasonCodes.length) {
    filter.seasonCode = { $in: rules.seasonCodes };
  }
  if (Array.isArray(rules.tags) && rules.tags.length) {
    filter.tags = { $in: rules.tags };
  }
  const from = rules.from ? new Date(rules.from) : null;
  const to = rules.to ? new Date(rules.to) : null;
  if (from || to) {
    filter.startsAt = {};
    if (from) filter.startsAt.$gte = from;
    if (to) filter.startsAt.$lte = to;
  }

  // La liste explicite NARROWS : pour un titre au porteur, une éligibilité trop
  // large coûte plus cher qu'une trop étroite.
  const list = (voucher?.eligibility?.events || []).filter(Boolean);
  if (list.length) filter.slug = { $in: list };

  return filter;
}

/**
 * Matchs où ce bon peut être utilisé : éligibles ET réellement ouverts à la
 * vente ET pas encore commencés. Un bon ne doit pas proposer un match passé.
 */
export async function listEligibleEvents(voucher) {
  const filter = {
    ...eligibleEventFilter(voucher),
    sale: 'onsale',
    activity: 'active',
    startsAt: { ...(eligibleEventFilter(voucher).startsAt || {}), $gt: new Date() }
  };
  return Event.find(filter).sort({ startsAt: 1 }).lean();
}

/** Ce bon peut-il servir sur CE match ? (mêmes règles que la liste ci-dessus) */
export async function isEventEligible(voucher, ev) {
  if (!ev) return false;
  if (ev.sale !== 'onsale' || ev.activity !== 'active') return false;
  if (ev.startsAt && new Date(ev.startsAt).getTime() <= Date.now()) return false;
  const match = await Event.findOne({ ...eligibleEventFilter(voucher), _id: ev._id }, { _id: 1 }).lean();
  return Boolean(match);
}

/** Combien de places ce bon a déjà prises sur ce match (plafond par match, Q1). */
export function usedOnEvent(voucher, eventSlug) {
  return (voucher?.redemptions || [])
    .filter(r => String(r.eventSlug || '') === String(eventSlug || ''))
    .reduce((n, r) => n + Number(r.qty || 0), 0);
}

/**
 * Nombre de places encore retirables sur ce match : le minimum entre le solde
 * global et ce que le plafond par match laisse.
 */
export function allowanceForEvent(voucher, eventSlug) {
  const pool = remainingOf(voucher);
  const cap = Number(voucher?.maxPerEvent || 0);
  if (cap <= 0) return pool;
  return Math.max(0, Math.min(pool, cap - usedOnEvent(voucher, eventSlug)));
}

export async function loadVoucherByToken(id) {
  const tok = decodeVoucherToken(id);
  if (!tok) return null;
  return Voucher.findOne({ code: String(tok.code).toUpperCase() });
}

// ————————————————————————————————————————————————————————————————
// Achat d'un bon (amont). Le RETRAIT est identique qu'un bon ait été offert
// par le club ou acheté par un tiers ; seule l'émission diffère, d'où cette
// section séparée qui ne fait que fabriquer un Voucher au bon moment.
// ————————————————————————————————————————————————————————————————

import fs from 'node:fs';
import path from 'node:path';

const PURCHASE_CONFIG_PATH = path.resolve(process.cwd(), 'data', 'customization', 'voucher-purchase.json');

const PURCHASE_DEFAULTS = {
  enabled: false,
  pricePerPlaceCents: 0,
  minPlaces: 1,
  maxPlaces: 10,
  validityDays: 365,
  maxPerEvent: 0,
  allowedZones: [],
  tags: [],
  seasonCodes: [],
  tariffCode: 'INVITATION'
};

/**
 * Paramètres de vente, relus à chaque appel : le tarif d'un bon change d'une
 * saison à l'autre et doit pouvoir être ajusté sans redéploiement.
 */
export function loadPurchaseConfig() {
  try {
    const raw = fs.readFileSync(PURCHASE_CONFIG_PATH, 'utf8');
    return { ...PURCHASE_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...PURCHASE_DEFAULTS };
  }
}

// Sans I/O/0/1 : un code se lit au téléphone et se recopie à la main.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generateVoucherCode(prefix = 'VCH') {
  const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  return `${prefix}-${pick()}-${pick()}`;
}

/**
 * Fabrique le bon d'une commande d'achat une fois celle-ci payée.
 *
 * Idempotent : appelé depuis la finalisation, qui peut rejouer (retour
 * navigateur, webhook, relance). Un bon déjà émis pour cette commande est
 * simplement renvoyé, sinon un double paiement offrirait deux fois les places.
 */
export async function issueVoucherForPurchase(order) {
  if (!order?._id) return null;
  const existing = await Voucher.findOne({ 'origin.orderId': order._id });
  if (existing) return existing;

  const cfg = loadPurchaseConfig();
  const meta = order.meta || {};
  const places = Math.max(1, Number(meta.voucherPlaces || 0));

  const expiresAt = Number(cfg.validityDays) > 0
    ? new Date(Date.now() + Number(cfg.validityDays) * 24 * 3600 * 1000)
    : null;

  // Le périmètre est figé À L'ACHAT : l'acheteur a payé pour ce qui lui était
  // annoncé, un changement ultérieur du barème ne doit pas le lui retirer.
  return Voucher.create({
    code: generateVoucherCode(),
    label: String(meta.voucherRecipient || '').trim() || `Achat ${order.payerLastName || ''}`.trim(),
    balance: { total: places, used: 0 },
    maxPerEvent: Number(meta.voucherMaxPerEvent ?? cfg.maxPerEvent ?? 0),
    eligibility: {
      events: [],
      rules: {
        seasonCodes: Array.isArray(meta.voucherSeasonCodes) ? meta.voucherSeasonCodes : (cfg.seasonCodes || []),
        tags: Array.isArray(meta.voucherTags) ? meta.voucherTags : (cfg.tags || []),
        from: null,
        to: expiresAt
      }
    },
    allowedZones: Array.isArray(meta.voucherZones) ? meta.voucherZones : (cfg.allowedZones || []),
    tariffCode: cfg.tariffCode || 'INVITATION',
    expiresAt,
    status: 'active',
    origin: { kind: 'purchase', orderId: order._id, note: String(meta.voucherMessage || '') }
  });
}
