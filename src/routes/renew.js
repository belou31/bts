// src/routes/renew.js
import mongoose from 'mongoose';   // ObjectId pour un groupKey unique par commande
import express from 'express';
import jwt from 'jsonwebtoken';

import { Subscriber }  from '../models/Subscriber.js';
import { Seat }        from '../models/Seat.js';
import { Zone }        from '../models/Zone.js';
import { Tariff }      from '../models/Tariff.js';
import { TariffPrice } from '../models/TariffPrice.js';
import { Order }       from '../models/Order.js';

import { createCheckoutIntent, buildReturnUrls, currentPaymentProviderId, currentPaymentSupportsInstallments } from '../services/payments/index.js';
import { makeTokenHash } from '../utils/ha-token.js';
import { findSingleGaps }      from '../utils/no-single-gap.js';
import { isVirtualZoneSeatId, zoneKeyFromSeatId as zoneKeyOf } from '../utils/seat-id.js';
import { withMetaZonePrices } from '../utils/meta-zones.js';
import { filterTariffsAndPricesByChannel } from '../utils/tariff-filter.js';
import { getPartnerConfig } from '../config/partners.js';
import {
  buildZonesWithRemaining,
  selectZoneAllocatedZones,
  computeZoneUsageAllOrders,
  computeProvisionalZoneClaims,
  remainingForZone
} from '../utils/zone-availability.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const PAYMENT_PROVIDER_ID = currentPaymentProviderId();
const HOLD_MS = Number(process.env.CHECKOUT_HOLD_MIN || '5') * 60 * 1000;

// ---------- Helpers ----------
function zoneKeyFromSeatId(seatId) {
  const s = String(seatId || '');
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : s;
}
function decodeToken(id) {
  if (!id || !JWT_SECRET) return null;
  try { return jwt.verify(id, JWT_SECRET); }
  catch { return null; }
}
function normSeatId(s) { return String(s || '').trim(); }

// Same helpers as event-flow.factory.js — the checkout response needs
// providerUrl+statusUrl or the shared order/index.ejs client (generic-view.js)
// never opens the active-polling booking-status panel and falls back to a
// bare full-page redirect + /pay/return's slow 8s self-refresh.
function buildPayStartUrl(orderId) {
  const app = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return `${app}/pay/start?orderId=${encodeURIComponent(String(orderId))}`;
}
function buildPayStatusUrl(orderId) {
  const app = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return `${app}/pay/status?orderId=${encodeURIComponent(String(orderId))}`;
}
function buildPayReturnUrl(orderId, checkoutId) {
  const app = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const oid = encodeURIComponent(String(orderId));
  const ci  = checkoutId ? `&ci=${encodeURIComponent(String(checkoutId))}` : '';
  return `${app}/pay/return?oid=${oid}${ci}`;
}

function buildSeatSubscribersFromSeats(seats, existing = {}) {
  const out = { ...existing };
  for (const s of seats || []) {
    const sid = normSeatId(
      (typeof s === 'string') ? s : (s.seatId || s.id || s.label || '')
    );
    if (!sid) continue;

    if (!out[sid]) {
      // essaie différentes conventions de champs
      const firstName = s.holderFirstName || s.firstName || s.subscriber?.firstName || '';
      const lastName  = s.holderLastName  || s.lastName  || s.subscriber?.lastName  || '';
      const email     = s.holderEmail     || s.email     || s.subscriber?.email     || '';
      if (firstName || lastName || email) {
        out[sid] = { firstName, lastName, email };
      }
    }
  }
  return out;
}

// Construit un index (zoneKey|tariffCode -> priceCents)
function buildPricesIndex(prices) {
  const idx = new Map();
  for (const p of prices || []) {
    const z = String(p.zoneKey || p.zone || '').toUpperCase();
    const t = String(p.tariffCode || p.tariff || '').toUpperCase();
    if (!z || !t) continue;
    idx.set(`${z}|${t}`, Number(p.priceCents || 0));
  }
  return idx;
}
function getPriceCents(pricesIdx, zoneKey, tariffCode) {
  const z = String(zoneKey || '').toUpperCase();
  const t = String(tariffCode || '').toUpperCase();
  return pricesIdx.get(`${z}|${t}`) ?? 0;
}

// The Subscriber rows this token speaks for. Two things come from them:
// their _ids, which are what Seat.provisionedFor points at (the proof that a
// provisioned seat is this renewer's own rather than someone else's still
// reserved), and their `extra` allowance.
async function subscribersForToken(tok) {
  const { seasonCode, venueSlug, groupKey, email } = tok;
  const or = [];
  if (groupKey) or.push({ groupKey });
  if (email) or.push({ email });
  if (!or.length) return [];
  // `places` fait partie du quota au même titre qu'`extra` : l'omettre de la
  // projection le laissait à undefined, donc compté pour 1, et un abonné ayant
  // plusieurs places dans une même zone en perdait autant.
  return Subscriber.find(
    { seasonCode, venueSlug, $or: or },
    { _id: 1, extra: 1, places: 1 }
  ).lean();
}

// A renewal link is no longer restricted to the exact seats it was issued for:
// the renewer may swap any of them for another free seat, and may take up to
// `extra` additional ones.
//
// `extra` is read from the Subscriber rows at request time rather than from
// the token, even though export-renew-groups.js also stamps it in: a token
// lives ~30 days, so a quota frozen at issue time would force reissuing every
// link just to grant a place (and would silently ignore an `extra` imported
// after the links went out). Reading live also lets links minted before the
// field existed pick it up on their own. It is operator-controlled data, so
// there is nothing a renewer can influence here. The token's own claim is
// kept only as a fallback for when the subscriber rows are gone (campaign
// closed/purged).
//
// MAX, never sum: the import CSV is one row per SEAT, so a family of three
// each marked extra=1 is granted one more place, not three — same rule as
// export-renew-groups.js.
function resolveQuota(tok, subs) {
  const previousSeats = (tok.seatIds || []).map(normSeatId).filter(Boolean);

  if (Array.isArray(subs) && subs.length) {
    const extra = Math.max(0, ...subs.map(s => Number(s.extra) || 0));
    // Somme des PLACES, pas nombre de sièges distincts : une place en zone n'a
    // pas d'identifiant propre, donc deux places dans la même zone tiennent en
    // un seul seatId. Compter les identifiants retirait silencieusement une
    // place à tout abonné ayant plusieurs places dans une même zone.
    const places = subs.reduce((sum, s) => sum + Math.max(1, Number(s.places) || 1), 0);
    return { previousSeats, extra, quota: places + extra };
  }

  const extra = Math.max(0, Number(tok.extra) || 0);
  const claimed = Number(tok.quota);
  const quota = Number.isFinite(claimed) && claimed > 0 ? claimed : previousSeats.length + extra;
  return { previousSeats, extra, quota };
}

// Mongo filter matching exactly the seats this renewer is allowed to take:
// anything genuinely free, plus their own still-provisioned seats. A seat
// provisioned for ANOTHER subscriber never matches — without that guard, free
// seat choice would let one renewer book a seat another renewer is still
// entitled to.
function claimableSeatFilter({ previousSeats, subscriberIds }) {
  const or = [{ status: 'available' }];
  if (subscriberIds.length) {
    or.push({ status: 'provisioned', provisionedFor: { $in: subscriberIds } });
  }
  // Fallback for provisioning done before provisionedFor was populated (or
  // pointing at a subscriber row since re-keyed): the token itself is proof
  // these seats belong to this renewer.
  if (previousSeats.length) {
    or.push({ status: 'provisioned', seatId: { $in: previousSeats } });
  }
  return or;
}

// A zone place has no Seat, so its "seat id" is a synthetic slot label
// (<ZONE>-Z001). The client numbers those from what it can see — its own cart
// — so every renewer picking a first zone extra proposes -Z001, colliding with
// whatever other renewers already hold. Two orders carrying the same label
// would confuse gate staff, and would make alreadyPaidSeatIdsForToken read one
// renewer's paid slot as proof that another's was already honoured. The server
// therefore assigns the numbers, from indices nobody is using yet.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function allocateZoneSeatIds({ seasonCode, venueSlug, zoneKey, count }) {
  const key = String(zoneKey || '').toUpperCase();
  const rx = new RegExp(`^${escapeRegex(key)}-Z(\\d{3,})$`, 'i');
  const used = new Set();

  const orders = await Order.find(
    { seasonCode, venueSlug, status: { $nin: ['canceled', 'failed'] }, 'lines.zoneKey': key },
    { 'lines.seatId': 1 }
  ).lean();
  for (const ord of orders) {
    for (const line of (ord.lines || [])) {
      const m = rx.exec(String(line?.seatId || ''));
      if (m) used.add(Number(m[1]));
    }
  }

  const subs = await Subscriber.find(
    { seasonCode, venueSlug, prefSeatId: rx },
    { prefSeatId: 1 }
  ).lean();
  for (const sub of subs) {
    const m = rx.exec(String(sub?.prefSeatId || ''));
    if (m) used.add(Number(m[1]));
  }

  const out = [];
  for (let n = 1; out.length < count; n++) {
    if (used.has(n)) continue;
    used.add(n);
    out.push(`${key}-Z${String(n).padStart(3, '0')}`);
  }
  return out;
}

// Which seatIds from this renewal token are already covered by a paid/tobepaid
// order? Real seats already get this via Seat.status, but a standing-zone
// virtual seat (e.g. "FAN_ZONE-Z001") has no Seat document at all — nothing
// else can tell a second checkout attempt that the slot was already renewed.
async function alreadyPaidSeatIdsForToken({ seasonCode, venueSlug, seatIds }) {
  const orders = await Order.find(
    {
      seasonCode, venueSlug,
      'origin.flow': { $in: ['subscription', 'renew'] },
      status: { $in: ['paid', 'tobepaid'] },
      'lines.seatId': { $in: seatIds }
    },
    { 'lines.seatId': 1 }
  ).lean();
  const covered = new Set();
  for (const ord of orders) {
    for (const line of (ord.lines || [])) {
      const sid = normSeatId(line?.seatId);
      if (sid && seatIds.includes(sid)) covered.add(sid);
    }
  }
  return covered;
}

// ---------- GET /s/renew?id=<jwt> ----------
/**
 * Répond au front avec les données nécessaires pour l’écran Renew.
 * Sortie: { season, seasonCode, venue, venueSlug, tariffs, prices, seats, tokenSeats, seatSubscribers, payer, blockedAny, blockedSeats }
 */
router.get('/renew', async (req, res) => {
  try {
    const id  = req.query.id || '';
    const tok = decodeToken(id);
    if (!tok || !tok.seasonCode || !tok.venueSlug || !tok.seatIds?.length) {
      return res.status(400).json({ error: 'missing_or_invalid_token' });
    }
    const { seasonCode, venueSlug, seatIds } = tok;
    const tokenSet = new Set(seatIds.map(normSeatId));

    // Tarifs & prix
    //
    // `Tariff` est global : ni seasonCode ni venueSlug au schéma, et son champ
    // d'état est `active`. `TariffPrice` n'a aucun état. Les critères qui
    // figuraient ici étaient supprimés par strictQuery — la requête renvoyait
    // tous les tarifs, inactifs et propres à un match compris. Même définition
    // que routes/subscription.js : renouvellement et abonnement doivent voir
    // exactement la même grille.
    // Le filtrage par canal manquait ici : la page de renouvellement exposait
    // les tarifs réservés aux partenaires (NORMAL_P01, CS_PARTNER…) et les
    // tarifs 'private' (INVITATION), qu'aucun renouveleur ne doit voir. Un
    // renouvellement est un abonnement : même canal que /subscribe.
    const allTariffs = await Tariff.find({ priceTableKey: null, active: true }).lean();
    const allPrices  = await withMetaZonePrices(
      await TariffPrice.find({ seasonCode, venueSlug }).lean(),
      { seasonCode, venueSlug }
    );
    // Canal tarifaire. Le partenaire vient du JETON SIGNÉ, jamais de l'URL :
    // sans quoi n'importe quel renouveleur s'attribuerait les tarifs réservés
    // d'un partenaire en ajoutant /partner/<slug>/ à son propre lien.
    // fallbackToPublic : un partenaire sans grille propre garde les tarifs
    // publics plutôt que de se retrouver sans aucun tarif.
    const channelCtx = tok.partnerSlug
      ? { kind: 'partner', partnerSlug: String(tok.partnerSlug).toLowerCase() }
      : { kind: 'subscription' };
    const { tariffs, prices } = filterTariffsAndPricesByChannel(
      allTariffs, allPrices, channelCtx, { fallbackToPublic: Boolean(tok.partnerSlug) }
    );

    // Zones : une place supplémentaire peut aussi être prise en zone, pas
    // seulement sur un siège numéroté. Même calcul de disponibilité que
    // l'abonnement (utils/zone-availability.js) — les deux puisent dans le
    // même quota. Deux filtres : svgSelector (sans lui, rien à cliquer sur le
    // plan) et zones vendues en bloc uniquement — une tribune dont les sièges
    // se choisissent un par un n'a pas à proposer de bouton en plus.
    // Troisième filtre : une zone sans tarif s'ajouterait au panier à 0 € —
    // l'abonnement écarte les zones non tarifées côté client, on fait pareil
    // ici mais côté serveur.
    const pricedZoneKeys = new Set(
      prices.map(p => String(p.zoneKey || p.zone || '').trim().toUpperCase()).filter(Boolean)
    );
    const zoneDocs = (await Zone.find({ seasonCode, venueSlug, isActive: true }).lean())
      .filter(z => z?.svgSelector && pricedZoneKeys.has(String(z.key || '').trim().toUpperCase()));
    const zones = await buildZonesWithRemaining({
      seasonCode, venueSlug,
      zones: await selectZoneAllocatedZones({ seasonCode, venueSlug, zones: zoneDocs })
    });

    // Toute la salle, pas seulement les sièges du token : le renouveleur peut
    // désormais changer de place, donc le plan doit montrer ce qui est libre.
    const mySubs = await subscribersForToken(tok);
    const { previousSeats, extra, quota } = resolveQuota(tok, mySubs);
    const mineIds = new Set(mySubs.map(s => String(s._id)));
    const previousSet = new Set(previousSeats);
    const allSeats = await Seat.find({ seasonCode, venueSlug }).lean();

    // Un siège "provisioned" est rendu inclickable par le front (mapSeatState
    // → busy). Ceux qui appartiennent à CE renouveleur doivent rester
    // sélectionnables : on les présente comme disponibles. Ceux provisionnés
    // pour quelqu'un d'autre gardent leur statut et restent bloqués.
    const seats = allSeats.map((s) => {
      const mine = s.status === 'provisioned'
        && (previousSet.has(normSeatId(s.seatId)) || (s.provisionedFor && mineIds.has(String(s.provisionedFor))));
      return mine ? { ...s, status: 'available', provisionedForMe: true } : s;
    });

    // Abonnés liés aux sièges du token
    // (NB: pas de champ seatId dans le modèle; on matche sur prefSeatId et previousSeasonSeats)
    const subs = await Subscriber.find(
      {
        seasonCode, venueSlug,
        $or: [
          { prefSeatId: { $in: seatIds } },
          { previousSeasonSeats: { $in: seatIds } }
        ]
      },
      // projection minimale utile
      'firstName lastName email prefSeatId previousSeasonSeats'
    ).lean();

    // Map { seatIdDuToken -> {firstName,lastName,email} }
    const seatSubscribersRaw = {};
    for (const s of subs || []) {
      const pref = normSeatId(s.prefSeatId);
      let match = pref && tokenSet.has(pref) ? pref : null;
      if (!match && Array.isArray(s.previousSeasonSeats)) {
        match = s.previousSeasonSeats.map(normSeatId).find(x => tokenSet.has(x)) || null;
      }
      if (!match) continue;
      seatSubscribersRaw[match] = {
        firstName: s.firstName || '',
        lastName:  s.lastName  || '',
        email:     s.email     || ''
      };
    }

    // Compléter depuis seats (au cas où certains holders seraient recopiés côté Seat)
    // — restreint aux sièges du token : `seats` couvre maintenant toute la salle.
    const tokenSeatDocs = seats.filter(s => tokenSet.has(normSeatId(s.seatId)));
    const seatSubscribers = buildSeatSubscribersFromSeats(tokenSeatDocs, seatSubscribersRaw);

    // Payer par défaut : d'abord celui du premier seatId du token, sinon le premier dispo, sinon vide
    let payer = {
      firstName: seatSubscribers?.[seatIds[0]]?.firstName || '',
      lastName : seatSubscribers?.[seatIds[0]]?.lastName  || '',
      email    : seatSubscribers?.[seatIds[0]]?.email     || ''
    };
    if (!(payer.firstName || payer.lastName || payer.email)) {
      const any = Object.values(seatSubscribers)[0];
      if (any) {
        payer = {
          firstName: any.firstName || '',
          lastName : any.lastName  || '',
          email    : any.email     || ''
        };
      }
    }

    // Statuts bloqués (info UI) — sièges réels déjà occupés. Ne concerne que les
    // sièges DU TOKEN ("votre ancienne place est partie") : `seats` couvre
    // maintenant toute la salle, dont chaque siège vendu à quelqu'un d'autre,
    // qui n'a rien à faire dans cette alerte.
    const blockedFromSeats = tokenSeatDocs
      .filter(s => s.status && String(s.status).toLowerCase() !== 'available')
      .map(s => s.seatId);
    // ...+ sièges virtuels de zone (debout) déjà couverts par une commande payée :
    // il n'existe aucun Seat pour ces id, donc rien d'autre ne peut détecter qu'un
    // renouvellement debout a déjà été honoré — sans ce contrôle, un lien de
    // renouvellement reste indéfiniment réutilisable et peut créer des commandes
    // payées en double pour la même place.
    const alreadyPaidSeatIds = await alreadyPaidSeatIdsForToken({ seasonCode, venueSlug, seatIds });
    const blockedSeats = Array.from(new Set([...blockedFromSeats, ...alreadyPaidSeatIds]));
    const blockedAny = blockedSeats.length > 0;

    return res.json({
      season: seasonCode, seasonCode,
      venue : venueSlug,  venueSlug,
      tariffs, prices, seats, zones,
      tokenSeats: seatIds,
      seatSubscribers,   // ← rempli à partir de prefSeatId / previousSeasonSeats
      payer,             // ← renseigné si possible
      blockedAny,
      blockedSeats,
      // Changement de place : le renouveleur n'est plus limité à ses anciens
      // sièges, seulement à leur NOMBRE (+ extra). Le front s'en sert pour
      // borner le panier ; POST /s/renew le revalide côté serveur.
      previousSeats,
      extra,
      quota
    });
  } catch (e) {
    console.error('[GET /s/renew] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});


// ---------- POST /s/renew?id=<jwt> ----------
/**
 * Reçoit le panier Renew et crée l’Order + intent chez le prestataire de paiement.
 * Body: { items:[{seatId, lastName, firstName, tariffCode, justif?, info?}, ...], payer:{firstName,lastName,email}, schedule:1|2|3 }
 * Réponse: { ok:true, orderId, totalCents, redirectUrl }
 */
router.post('/renew', async (req, res) => {
  try {
    const id  = req.query.id || '';
    const tok = decodeToken(id);
    if (!tok || !tok.seasonCode || !tok.venueSlug || !tok.seatIds?.length) {
      return res.status(400).json({ error: 'missing_or_invalid_token' });
    }

    const { seasonCode, venueSlug } = tok;
    const mySubs = await subscribersForToken(tok);
    const { previousSeats, quota } = resolveQuota(tok, mySubs);
    const items    = Array.isArray(req.body.items) ? req.body.items : [];
    const payer    = req.body.payer || {};
    const schedule = Number(req.body.schedule || 1);

    if (!items.length)        return res.status(400).json({ error: 'empty_items' });
    if (!payer?.email)        return res.status(400).json({ error: 'payer_email_required' });
    if (![1,2,3].includes(schedule)) return res.status(400).json({ error: 'invalid_schedule' });
    // Garde-fou serveur : le sélecteur ne propose l'échéancier que si le
    // prestataire sait l'encaisser, mais une requête forgée pourrait tout de
    // même demander 3. On refuse plutôt que d'enregistrer un échéancier qui
    // ne sera jamais honoré — le client serait débité en une fois.
    if (schedule > 1 && !currentPaymentSupportsInstallments()) {
      return res.status(400).json({ error: 'installments_unsupported' });
    }

    // Sièges vraiment demandés
    const seatIdsAsked = [...new Set(items.map(i => normSeatId(i.seatId)))];

    // Le token n'est plus une liste blanche de sièges mais un QUOTA : le
    // renouveleur choisit librement où s'asseoir, dans la limite du nombre de
    // places auquel il a droit.
    if (seatIdsAsked.length > quota) {
      return res.status(403).json({ error: 'quota_exceeded', quota, asked: seatIdsAsked.length });
    }

    // Places de zone debout demandées EN PLUS de celles portées par le token.
    // Elles n'ont pas de Seat à verrouiller, donc là où un siège numéroté est
    // arbitré par le updateMany atomique plus bas, une place de zone se
    // contrôle sur le quota de la zone — même calcul qu'à l'abonnement.
    const newZoneSeatIds = seatIdsAsked.filter(
      sid => isVirtualZoneSeatId(sid) && !previousSeats.includes(sid)
    );
    // client-proposed slot label -> the one the server actually assigns
    const zoneSeatIdRemap = new Map();
    if (newZoneSeatIds.length) {
      const perZone = new Map();
      for (const sid of newZoneSeatIds) {
        const zk = zoneKeyOf(sid);
        perZone.set(zk, (perZone.get(zk) || 0) + 1);
      }
      const zoneKeys = Array.from(perZone.keys());
      const zoneDocs = await Zone.find({
        seasonCode, venueSlug, isActive: true, key: { $in: zoneKeys }
      }).lean();
      const zoneMap = new Map(zoneDocs.map(z => [String(z.key || '').toUpperCase(), z]));

      const { usage, coveredSeatIds } = await computeZoneUsageAllOrders({
        seasonCode, venueSlug, zoneKeys, statusIn: ['paid']
      });
      const provisional = await computeProvisionalZoneClaims({
        seasonCode, venueSlug, zoneKeys, coveredSeatIds
      });

      for (const [zoneKey, count] of perZone) {
        const zone = zoneMap.get(zoneKey);
        if (!zone) return res.status(400).json({ error: 'invalid_zone', zoneKey });
        const used = (usage.get(zoneKey) || 0) + (provisional.get(zoneKey) || 0);
        const remaining = remainingForZone(zone, used);
        if (count > remaining) {
          return res.status(409).json({ error: 'zone_quota_exceeded', zoneKey, remaining });
        }

        const assigned = await allocateZoneSeatIds({ seasonCode, venueSlug, zoneKey, count });
        newZoneSeatIds
          .filter(sid => zoneKeyOf(sid) === zoneKey)
          .forEach((sid, i) => zoneSeatIdRemap.set(sid, assigned[i]));
      }
    }

    // Un lien de renouvellement reste valable jusqu'à son expiration JWT — sans
    // ce contrôle, le rouvrir après un renouvellement déjà payé (ou un double
    // clic) crée une seconde commande payée pour la même place. Pour un siège
    // réel, la vérif seatStatus (holdable/conflit) plus bas fait déjà ce travail ;
    // ceci couvre en plus les places de zone debout, qui n'ont pas de Seat.
    //
    // Limité aux sièges DU TOKEN : la question est « ce lien a-t-il déjà été
    // honoré ? ». Une place de zone nouvellement choisie n'en fait pas partie,
    // et son libellé peut légitimement exister dans la commande payée d'un
    // autre abonné — la compter ici rejetterait la demande à tort.
    const previousAsked = seatIdsAsked.filter(sid => previousSeats.includes(sid));
    const alreadyPaidAsked = previousAsked.length
      ? await alreadyPaidSeatIdsForToken({ seasonCode, venueSlug, seatIds: previousAsked })
      : new Set();
    if (alreadyPaidAsked.size) {
      return res.status(409).json({ error: 'already_renewed', seatIds: Array.from(alreadyPaidAsked) });
    }

    // Prix (index)
    const prices   = await withMetaZonePrices(
      await TariffPrice.find({ seasonCode, venueSlug }).lean(),
      { seasonCode, venueSlug }
    );
    const pricesIx = buildPricesIndex(prices);

    // Construire les lignes + total
    const lines = [];
    let totalCents = 0;
    for (const it of items) {
      const asked = normSeatId(it.seatId);
      const seatId = zoneSeatIdRemap.get(asked) || asked;
      const zoneKey = zoneKeyFromSeatId(seatId);
      const tariffCode = String(it.tariffCode || '').toUpperCase();
      const priceCents = getPriceCents(pricesIx, zoneKey, tariffCode);

      lines.push({
        seatId,
        zoneKey,
        // Explicite plutôt que redéduit du format du seatId : les places de
        // zone ne sont plus seulement celles héritées du token.
        unitType: isVirtualZoneSeatId(seatId) ? 'zone' : 'seat',
        holderFirstName: String(it.firstName || ''),
        holderLastName:  String(it.lastName  || ''),
        tariffCode,
        priceCents,
        justif: String(it.justif || ''),
        info:   String(it.info   || '')
      });
      totalCents += Number(priceCents || 0);
    }


    // 🚫 RÈGLE ANTI-TROU (serveur) — contrôle avant création de l'order
    //    Ne considère que les lignes "siège" (les zones virtuelles n'existent pas en Renew)
    /*{
      const seatIdsAsked = lines.map(l => l.seatId).filter(Boolean);
      const gaps = await findSingleGaps({ seasonCode, venueSlug, selectedSeatIds: seatIdsAsked });
      if (gaps.length) {
        const g = gaps[0];
        return res.status(409).json({
          error: 'no_single_gap',
          message: `Votre sélection créerait un siège isolé en rangée ${g.row} (zone ${g.zoneKey}).`,
          problems: gaps
        });
      }
    }*/


    // Créer la commande (pending)
    // Un renouvellement partenaire reste un RENOUVELLEMENT : il ne consomme pas
    // l'allocation de vente du partenaire (presale.seasons[...].quota), qui
    // plafonne les abonnements NOUVEAUX. Compter les renouvellements réduirait
    // chaque année l'allocation d'un partenaire pour des abonnés qu'il a déjà.
    // meta.partner.slug est néanmoins posé : c'est ce qui rattache la commande
    // au partenaire dans /partner/<slug>/admin et les exports.
    const partnerSlug = tok.partnerSlug ? String(tok.partnerSlug).toLowerCase() : null;

    const order = await Order.create({
      itemName: partnerSlug ? `RENEW_${seasonCode}_${partnerSlug.toUpperCase()}` : `RENEW_${seasonCode}`,
      seasonCode,
      venueSlug,
      phase: 'renew',
      // Unique par commande — voir subscription.js : un groupKey constant
      // transformait uniq_paid_per_payer en « un seul renouvellement payé par
      // personne et par saison », rejetant tout second paiement légitime.
      groupKey: `RENEW-${seasonCode}-${new mongoose.Types.ObjectId().toString()}`,
      payerFirstName: String(payer.firstName || ''),
      payerLastName:  String(payer.lastName  || ''),
      payerEmail:     String(payer.email     || ''),
      paymentSplit:   schedule,
      lines,
      totalCents,
      status: 'pending',
      paymentProvider: PAYMENT_PROVIDER_ID,
      paymentProviderMeta: {},
      origin: {
        flow:   'renew',
        uiPath: partnerSlug
          ? `/partner/${encodeURIComponent(partnerSlug)}/season/${encodeURIComponent(seasonCode)}/renew`
          : `/season/${encodeURIComponent(seasonCode)}/renew`,
        apiPath:`${req.baseUrl || ''}${req.path}`
      },
      mailTemplateKind: 'renew',
      ...(partnerSlug
        ? { meta: { partner: { slug: partnerSlug, name: getPartnerConfig(partnerSlug)?.name || partnerSlug, renewal: true } } }
        : {})
    });

    // Verrouillage des sièges réels. Avant le changement de place, un lien ne
    // pouvait toucher que SES propres sièges déjà provisionnés : aucune course
    // possible, donc aucun hold. Maintenant que n'importe quel siège libre peut
    // être choisi, deux renouveleurs peuvent viser la même place en même temps —
    // ce updateMany atomique tranche (et refuse au passage les sièges
    // provisionnés pour quelqu'un d'autre, que le filtre ne matche pas).
    const subscriberIds = mySubs.map(s => s._id);
    const realSeatIds = seatIdsAsked.filter(sid => sid && !isVirtualZoneSeatId(sid));
    if (realSeatIds.length) {
      const holdUntil = new Date(Date.now() + HOLD_MS);
      const upd = await Seat.updateMany(
        {
          seasonCode, venueSlug,
          seatId: { $in: realSeatIds },
          $or: claimableSeatFilter({ previousSeats, subscriberIds })
        },
        {
          $set: {
            status: 'busy',
            'meta.hold': { by: 'checkout', orderId: String(order._id), until: holdUntil }
          }
        },
        { runValidators: false }
      );
      const modified = Number(upd.modifiedCount ?? upd.nModified ?? 0);
      if (modified !== realSeatIds.length) {
        // Rollback strict : ne relâche que ce que CETTE commande vient de tenir.
        await Seat.updateMany(
          {
            seasonCode, venueSlug,
            seatId: { $in: realSeatIds },
            status: 'busy',
            'meta.hold.orderId': String(order._id)
          },
          { $set: { status: 'available' }, $unset: { 'meta.hold': 1 } },
          { runValidators: false }
        );
        order.status = 'failed';
        order.paymentProviderMeta = {
          ...(order.paymentProviderMeta || {}),
          reason: 'pre_hold_mismatch',
          expected: realSeatIds.length,
          modified
        };
        await order.save();
        return res.status(409).json({ error: 'seat_unavailable', expected: realSeatIds.length, held: modified });
      }
    }

    // Places abandonnées lors d'un changement : l'ancien siège que le
    // renouveleur ne reprend pas retourne immédiatement au pot commun.
    const droppedSeats = previousSeats.filter(sid => sid && !isVirtualZoneSeatId(sid) && !seatIdsAsked.includes(sid));
    if (droppedSeats.length) {
      await Seat.updateMany(
        {
          seasonCode, venueSlug,
          seatId: { $in: droppedSeats },
          status: 'provisioned'   // jamais un siège déjà vendu/tenu par ailleurs
        },
        { $set: { status: 'available' }, $unset: { provisionedFor: 1 } },
        { runValidators: false }
      );
    }

    const urls = buildReturnUrls(order);
    const intent = await createCheckoutIntent({
      order,
      returnUrl: urls.returnUrl,
      backUrl: urls.backUrl,
      errorUrl: urls.errorUrl
    });
    const { redirectUrl, raw, error } = intent;

    if (error || !redirectUrl) {
      console.error('[renew] createCheckoutIntent failed:', error);
      return res.status(502).json({ error: 'payment_unavailable' });
    }

    // Persist intent + tokenHash pour le retour /pay/return
    const checkoutId = String(intent?.id || intent?.checkoutReference || raw?.id || raw?.checkout_reference || '');
    if (checkoutId) {
      const checkoutReference = raw?.checkout_reference || intent?.checkoutReference || checkoutId;
      const tokenHash = makeTokenHash({ orderId: order._id, checkoutIntentId: checkoutId });
      order.paymentProviderMeta = {
        ...(order.paymentProviderMeta || {}),
        name: PAYMENT_PROVIDER_ID,
        checkoutIntentId: checkoutId,
        checkoutReference,
        providerRedirectUrl: redirectUrl || null,
        providerOrderId:
          intent.providerOrderId ||
          raw?.order?.id ||
          raw?.orderId ||
          raw?.transaction_code ||
          raw?.transaction_id ||
          raw?.id ||
          null,
        tokenHash
      };
      await order.save();
    }

    return res.json({
      ok: true,
      orderId: order._id,
      totalCents,
      redirectUrl: buildPayStartUrl(order._id),   // /pay/start (legacy fallback)
      providerUrl: redirectUrl,                    // direct provider URL (SumUp hosted checkout)
      statusUrl:   buildPayStatusUrl(order._id),   // polling endpoint
      returnUrl:   buildPayReturnUrl(order._id, checkoutId)
    });
  } catch (e) {
    console.error('[POST /s/renew] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
