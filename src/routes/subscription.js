// src/routes/subscription.js
import express from 'express';
import mongoose from 'mongoose'; // si pas déjà présent

import { Season }      from '../models/Season.js';
import { Seat }        from '../models/Seat.js';
import { Zone }        from '../models/Zone.js';
import { Tariff }      from '../models/Tariff.js';
import { TariffPrice } from '../models/TariffPrice.js';
import { Order }       from '../models/Order.js';

import { createCheckoutIntent, buildReturnUrls, currentPaymentProviderId, currentPaymentSupportsInstallments } from '../services/payments/index.js';
import { makeTokenHash }        from '../utils/ha-token.js';
import { findSingleGaps }       from '../utils/no-single-gap.js';
import { filterTariffsAndPricesByChannel } from '../utils/tariff-filter.js';
import { loadCustomization } from '../services/customization.js';
import { isVirtualZoneSeatId } from '../utils/seat-id.js';
import { withMetaZonePrices } from '../utils/meta-zones.js';
import { partnerSeasonQuota, partnerSeasonPresaleRemaining } from '../services/partner-presale.js';
import { resolveSeasonSubscribeAccess, seasonAccessMessage } from '../services/season-access.js';
import {
  buildZonesWithRemaining,
  selectZoneAllocatedZones,
  computeZoneUsageAllOrders,
  computeProvisionalZoneClaims
} from '../utils/zone-availability.js';

const router = express.Router({ mergeParams: true });

/* ====== ENV / Const ====== */
const PAYMENT_PROVIDER_ID = currentPaymentProviderId();

const HOLD_MIN = Number(process.env.CHECKOUT_HOLD_MIN || 10); // durée du hold en minutes
const HOLD_MS  = HOLD_MIN * 60 * 1000;

/* ====== Helpers ====== */
const norm  = s => String(s || '').trim();
const upper = s => norm(s).toUpperCase();

/* ====== URLs de paiement ======
 * Mêmes helpers que routes/renew.js. Sans providerUrl + statusUrl, le front
 * (generic-view.js) retombe sur la redirection pleine page héritée : le
 * panneau « Statut de la réservation » n'apparaît jamais, et l'acheteur perd
 * de vue son décompte comme sa confirmation.
 */
function buildPayStatusUrl(orderId) {
  const app = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return `${app}/pay/status?orderId=${encodeURIComponent(String(orderId))}`;
}
function buildPayStartUrl(orderId) {
  const app = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return `${app}/pay/start?orderId=${encodeURIComponent(String(orderId))}`;
}
function buildPayReturnUrl(orderId, checkoutId) {
  const app = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const oid = encodeURIComponent(String(orderId));
  const ci  = checkoutId ? `&ci=${encodeURIComponent(String(checkoutId))}` : '';
  return `${app}/pay/return?oid=${oid}${ci}`;
}

/* ====== Canal ======
 * Ce routeur sert deux montages : /api/season/... (public) et
 * /api/partner/:partnerSlug/season/... (partenaire). Le montage partenaire
 * pose req.partnerConfig ; tout le reste du flux est identique, ce qui évite
 * une seconde implémentation de l'abonnement qui divergerait de celle-ci.
 */
function partnerCtx(req) {
  const cfg = req.partnerConfig || null;
  if (!cfg) return null;
  return { cfg, slug: String(req.params?.partnerSlug || cfg.slug || '').trim().toLowerCase() };
}

function channelOf(req) {
  const p = partnerCtx(req);
  return p ? { kind: 'partner', partnerSlug: p.slug } : { kind: 'subscription' };
}

/** Délègue au service partagé, avec le contexte partenaire du montage. */
async function resolveSubscribeAccess(req, season, seasonCode) {
  const p = partnerCtx(req);
  return resolveSeasonSubscribeAccess({
    season, seasonCode,
    partnerCfg: p?.cfg || null,
    partnerSlug: p?.slug || ''
  });
}

async function getActiveSeasonAndVenue() {
  // `isActive` n'existe pas au schéma : strictQuery le supprimait de la requête,
  // qui renvoyait alors une saison arbitraire. On lit l'état réel.
  const s = await Season.findOne({ activity: 'active', subscribe: 'open' }).lean();
  if (!s) { const e = new Error('No active season/venue'); e.status = 503; throw e; }
  const seasonCode = s.code || s.seasonCode;
  const venueSlug  = s.venueSlug || s.venue;
  if (!seasonCode || !venueSlug) { const e = new Error('No active season/venue'); e.status = 503; throw e; }
  return { seasonCode, venueSlug, season: s };
}

async function resolveSeasonAndVenue(inputSeasonCode = '') {
  const requested = norm(inputSeasonCode);
  if (requested && requested.toLowerCase() !== 'current') {
    const seasonDoc = await Season.findOne({
      $or: [{ code: requested }, { seasonCode: requested }]
    }).lean();
    if (!seasonDoc) {
      const err = new Error(`Season not found: ${requested}`);
      err.status = 404;
      throw err;
    }
    const seasonCode = seasonDoc.code || seasonDoc.seasonCode || requested;
    const venueSlug = seasonDoc.venueSlug || seasonDoc.venue;
    if (!venueSlug) {
      const err = new Error('Season missing venue');
      err.status = 500;
      throw err;
    }
    return { seasonCode, venueSlug, season: seasonDoc };
  }
  return await getActiveSeasonAndVenue();
}

function buildPricesIndex(list) {
  // Map "ZONE|TARIFF" -> priceCents (avec fallback *|TARIFF)
  const idx = new Map();
  for (const p of (list || [])) {
    const z = upper(p.zoneKey || p.zone || '*');
    const t = upper(p.tariffCode || p.tariff || '');
    if (!t) continue;
    idx.set(`${z}|${t}`, Number(p.priceCents || 0));
    if (z !== '*' && !idx.has(`*|${t}`)) {
      idx.set(`*|${t}`, Number(p.priceCents || 0));
    }
  }
  return idx;
}
const getPriceCents = (idx, zoneKey, tariffCode) =>
  idx.get(`${upper(zoneKey)}|${upper(tariffCode)}`) ?? idx.get(`*|${upper(tariffCode)}`) ?? 0;

function zoneKeyFromSeatId(seatId) {
  const s = String(seatId || '');
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : s;
}

// Zone availability lives in src/utils/zone-availability.js: the renewal flow
// draws from the same zone quota and must not disagree on what "used" means.


/* ====== GET /api/season/:seasonCode/status ======
 * Répond: { seasonCode, venueSlug, tariffs[], prices[], seats[], zones[] }
 * zones[]: [{ key,name,quota,capacity,remaining,svgSelector }]
 */
router.get('/status', async (req, res, next) => {
  try {
    const seasonParam = req.params?.seasonCode || req.query?.season || req.query?.seasonCode || '';
    const { seasonCode, venueSlug, season } = await resolveSeasonAndVenue(seasonParam);
    // --- Sièges de la salle (pour le clic direct sur siège côté front)
    const seats = await Seat.find(
      { seasonCode, venueSlug },
      { _id:0, seatId:1, status:1, zoneKey:1 }
    ).lean();

    // --- Zones actives (avec svgSelector si fourni), vendues en bloc
    // uniquement : une tribune dont les sièges se choisissent un par un sur le
    // plan n'a pas à proposer en plus un bouton "ajouter une place".
    const zonesAll = await Zone.find({
      seasonCode, venueSlug,
      isActive: true
    }).lean();
    const zones = await selectZoneAllocatedZones({
      seasonCode, venueSlug,
      zones: zonesAll.filter(z => z?.svgSelector)
    });

    // --- Tarifs & Prix applicables (TOUS les prix / tarifs actifs pour la salle)
    const allPrices = await withMetaZonePrices(
      // TariffPrice n'a ni `isActive` ni `active` : le filtre qui figurait ici
      // était supprimé par strictQuery et n'a jamais rien filtré. Retiré plutôt
      // que corrigé — il n'y a pas d'état actif sur une ligne de prix.
      await TariffPrice.find({ seasonCode, venueSlug }).lean(),
      { seasonCode, venueSlug }
    );
  // Tarifs de saison : `Tariff` ne porte NI seasonCode NI venueSlug (ils sont
  // globaux, `priceTableKey` isolant les tarifs propres à un match), et son
  // champ d'état s'appelle `active`, pas `isActive`. Les trois critères qui
  // figuraient ici étaient donc supprimés par strictQuery : la requête
  // renvoyait TOUS les tarifs, y compris inactifs et propres à un événement.
    const allTariffs = await Tariff.find({ priceTableKey: null, active: true }).lean();
    // Un partenaire voit ses propres tarifs ; on retombe sur le public quand
    // aucun tarif ne lui est spécifiquement réservé.
    const channelCtx = channelOf(req);
    const { tariffs, prices } = filterTariffsAndPricesByChannel(
      allTariffs,
      allPrices,
      channelCtx,
      { fallbackToPublic: channelCtx.kind === 'partner' }
    );

    const customization = loadCustomization({ seasonCode, locale: req.locale });

    // --- “remaining” zone = plafond - USAGE(only paid) - claims de renouvellement en attente
    const zonesOut = await buildZonesWithRemaining({ seasonCode, venueSlug, zones });

    const access = await resolveSubscribeAccess(req, season, seasonCode);

    res.json({
      seasonCode,
      seasonName: season?.name || null,
      venueSlug, tariffs, prices, seats, zones: zonesOut, customization,
      // Le front a besoin de savoir s'il peut ouvrir le panier, et le
      // partenaire de voir ce qu'il lui reste.
      access: { allowed: access.allowed, reason: access.reason, message: access.allowed ? null : seasonAccessMessage(access.reason) },
      partner: access.partner
    });
  } catch (e) { next(e); }
});

/* ====== POST /api/season/:seasonCode/checkout ======
 * Body: {
 *   payer:{firstName,lastName,email},
 *   schedule:1|2|3,
 *   items:[{ seatId, zoneKey, firstName,lastName, tariffCode, justif?, info? }]
 * }
 * Accepte des lignes “siège” (seatId existant en BD) ET “zone” (seatId virtuel)
 */
router.post('/checkout', async (req, res) => {
  try {
    const seasonParam = req.params?.seasonCode || req.body?.seasonCode || req.query?.season || '';
    const { seasonCode, venueSlug, season } = await resolveSeasonAndVenue(seasonParam);
    const payer    = req.body?.payer || {};
    const schedule = Number(req.body?.schedule || 1);
    // Accepte "items" (nouveau) ET "lines" (héritage generic-view)
    let holdExpiresAt = null;   // renseigné à la pose des holds, renvoyé au front
    const items    = Array.isArray(req.body?.items)
      ? req.body.items
      : (Array.isArray(req.body?.lines) ? req.body.lines : []);


    if (!items.length) return res.status(400).json({ error: 'no_lines' });
    if (![1,2,3].includes(schedule)) return res.status(400).json({ error: 'invalid_schedule' });
    // Garde-fou serveur : le sélecteur ne propose l'échéancier que si le
    // prestataire sait l'encaisser, mais une requête forgée pourrait tout de
    // même demander 3. On refuse plutôt que d'enregistrer un échéancier qui
    // ne sera jamais honoré — le client serait débité en une fois.
    if (schedule > 1 && !currentPaymentSupportsInstallments()) {
      return res.status(400).json({ error: 'installments_unsupported' });
    }

    // Prix / Tarifs
    // Porte d'entrée : refusée avant toute écriture. Le quota partenaire est
    // revérifié plus bas, une fois le nombre de lignes connu.
    const access = await resolveSubscribeAccess(req, season, seasonCode);
    if (!access.allowed) {
      return res.status(403).json({ error: access.reason || 'subscribe_closed', message: seasonAccessMessage(access.reason) });
    }

    const channelCtx = channelOf(req);
    const allPrices = await withMetaZonePrices(
      await TariffPrice.find({ seasonCode, venueSlug }).lean(),
      { seasonCode, venueSlug }
    );
    const allTariffs = await Tariff.find({ priceTableKey: null, active: true }).lean();
    const prices = filterTariffsAndPricesByChannel(
      allTariffs, allPrices, channelCtx,
      { fallbackToPublic: channelCtx.kind === 'partner' }
    ).prices;
    const pricesIdx = buildPricesIndex(prices);

    // Pré-charge sièges demandés (pour distinguer siège réel vs “zone virtuelle”)
    const askedSeatIds = items.map(it => norm(it.seatId)).filter(Boolean);
    const dbSeats = askedSeatIds.length
      ? await Seat.find({ seasonCode, venueSlug, seatId: { $in: askedSeatIds } }).lean()
      : [];
    const seatMap = new Map(dbSeats.map(s => [s.seatId, s]));

    // Prépare contrôle quotas pour zones explicitement demandées, + zoneType
    // lookup pour toutes les zones concernées (y compris celles des sièges
    // réels, pour peupler zoneType même sur les lignes "SIÈGE").
    const requestedZoneKeys = new Set(
      items
        .map(it => norm(it.zoneKey))
        .filter(Boolean)
    );
    for (const s of dbSeats) {
      if (s.zoneKey) requestedZoneKeys.add(s.zoneKey);
    }
    const zones = requestedZoneKeys.size
      ? await Zone.find({
          seasonCode,
          venueSlug,
          key: { $in: Array.from(requestedZoneKeys) },
          isActive: true
        }).lean()
      : [];
    const zoneMap = new Map(zones.map(z => [z.key, z]));
    const requestedPerZone = new Map(); // zoneKey -> count (lignes “zone”)

    const lines = [];

    for (const it of items) {
      const seatId    = norm(it.seatId);
      const explicitZ = norm(it.zoneKey);
      const zoneKey   = explicitZ || (seatId ? zoneKeyFromSeatId(seatId) : '');

      const tariffCode = upper(it.tariffCode);
      const priceCents = getPriceCents(pricesIdx, zoneKey, tariffCode);

      if (seatMap.has(seatId)) {
        // ----- LIGNE “SIÈGE”
        const s = seatMap.get(seatId);
        if (s.status !== 'available') {
          return res.status(409).json({ error: 'seat_unavailable', seatId, status: s.status });
        }
        lines.push({
          seatId,
          zoneKey: s.zoneKey || zoneKey || '',
          unitType: 'seat',
          zoneType: (zoneMap.get(s.zoneKey) || {}).type || null,
          holderFirstName: norm(it.firstName),
          holderLastName:  norm(it.lastName),
          tariffCode,
          priceCents,
          justif: norm(it.justif),
          info:   norm(it.info)
        });
      } else {
        // ----- LIGNE “ZONE” (ID virtuel)
        if (!zoneKey || !zoneMap.has(zoneKey)) {
          return res.status(400).json({ error: 'invalid_zone', zoneKey });
        }
        lines.push({
          seatId,
          zoneKey,
          unitType: 'zone',
          zoneType: (zoneMap.get(zoneKey) || {}).type || null,
          holderFirstName: norm(it.firstName),
          holderLastName:  norm(it.lastName),
          tariffCode,
          priceCents,
          justif: norm(it.justif),
          info:   norm(it.info)
        });
        requestedPerZone.set(zoneKey, (requestedPerZone.get(zoneKey) || 0) + 1);
      }
    }


    // 🚫 RÈGLE ANTI-TROU (serveur) — contrôle avant création de l'order
    //    Ici on ne contrôle que les lignes “SIÈGE” réels (les lignes “ZONE” n’impactent pas une rangée).
    /*{
      const seatIdsAsked = lines
        .map(l => l.seatId)
        .filter(sid => !!sid && askedSeatIds.includes(sid)); // réels uniquement
      if (seatIdsAsked.length) {
        const { seasonCode, venueSlug } = await getActiveSeasonAndVenue();
        const gaps = await findSingleGaps({ seasonCode, venueSlug, selectedSeatIds: seatIdsAsked });
        if (gaps.length) {
          const g = gaps[0];
          return res.status(409).json({
            error: 'no_single_gap',
            message: `Votre sélection créerait un siège isolé en rangée ${g.row} (zone ${g.zoneKey}).`,
            problems: gaps
          });
        }
      }
    }*/



    // ----- CONTRÔLE DU QUOTA PARTENAIRE -----
    // Recompté ici et pas seulement à l'entrée : entre les deux, on connaît le
    // nombre d'abonnements demandés, et une autre commande a pu passer.
    {
      const p = partnerCtx(req);
      const quota = p ? partnerSeasonQuota(p.cfg, seasonCode) : 0;
      if (p && quota > 0) {
        const remaining = await partnerSeasonPresaleRemaining({
          cfg: p.cfg, partnerSlug: p.slug, seasonCode
        });
        if (lines.length > (remaining ?? 0)) {
          return res.status(409).json({
            error: 'partner_quota_exceeded',
            message: `Quota partenaire dépassé : ${remaining ?? 0} abonnement(s) restant(s) pour ${lines.length} demandé(s).`,
            quota,
            remaining: remaining ?? 0,
            requested: lines.length
          });
        }
      }
    }

    // ----- CONTRÔLE QUOTAS SUR LES ZONES -----
    if (requestedPerZone.size) {
      const zoneKeys = Array.from(requestedPerZone.keys());
      // Garde-fou anti-oversell : ne compter que le "paid" pour autoriser la vente,
      // + les claims de renouvellement en attente (sinon un checkout public pourrait
      // encore vendre une place déjà réservée pour un renouvellement non payé).
      const { usage, coveredSeatIds } = await computeZoneUsageAllOrders({
        seasonCode, venueSlug, zoneKeys, statusIn: ['paid']
      });
      const provisionalUsage = await computeProvisionalZoneClaims({ seasonCode, venueSlug, zoneKeys, coveredSeatIds });

      for (const [zoneKey, count] of requestedPerZone) {
        const z        = zoneMap.get(zoneKey);
        const used     = (usage.get(zoneKey) || 0) + (provisionalUsage.get(zoneKey) || 0);
        const quota    = Number(z.quota || 0);
        const capacity = Number(z.capacity || 0);
        const plafond  = quota > 0 ? quota : capacity;
        if (plafond > 0 && (used + count) > plafond) {
          return res.status(409).json({
            error: 'quota_exceeded',
            zoneKey,
            remaining: Math.max(0, plafond - used)
          });
        }
      }
    }

    const totalCents = lines.reduce((acc, l) => acc + Number(l.priceCents || 0), 0);

    // Créer l’order (pending)
    const seasonPath = `/season/${encodeURIComponent(seasonCode)}`;

    // meta.partner.slug est la clé sur laquelle se compte le quota : sans lui,
    // une commande partenaire n'est comptée nulle part et le quota ne descend
    // jamais. Voir services/partner-presale.js.
    const partner = partnerCtx(req);
    const partnerMeta = partner
      ? {
          partner: {
            slug: partner.slug,
            name: partner.cfg?.name || partner.slug,
            presale: access.partner?.presale === true
          }
        }
      : {};

    const order = await Order.create({
      itemName: partner ? `PARTNER_SUBSCRIPTION_${seasonCode}` : `SUBSCRIPTION_${seasonCode}`,
      seasonCode, venueSlug,
      phase: 'subscription',
      // groupKey UNIQUE par commande, comme le fait déjà le flux événement
      // (event-flow.factory.js). Un groupKey constant par saison faisait porter
      // à l'index uniq_paid_per_payer (saison, lieu, groupKey, payeur) le sens
      // « un seul paiement abouti par personne et par saison » : la seconde
      // commande d'un même acheteur — un siège ajouté en cours de saison —
      // était rejetée APRÈS réservation des sièges.
      // Le regroupement fonctionnel reste lisible via origin.flow et seasonCode.
      groupKey: partner
        ? `PARTNER-${partner.slug.toUpperCase()}-${seasonCode}-${new mongoose.Types.ObjectId().toString()}`
        : `SUBSCRIPTION-${seasonCode}-${new mongoose.Types.ObjectId().toString()}`,
      payerFirstName: norm(payer.firstName || ''),
      payerLastName:  norm(payer.lastName  || ''),
      payerEmail:     norm(payer.email     || ''),
      paymentSplit:   schedule,
      lines, totalCents, status: 'pending',
      paymentProvider: PAYMENT_PROVIDER_ID,
      paymentProviderMeta: {},
      // origin ne retient que flow/uiPath/apiPath (voir Order.js) : le
      // partenaire s'identifie par meta.partner.slug, qui est aussi la clé du
      // quota. Y ajouter un champ ici serait silencieusement perdu.
      origin: partner
        ? {
            flow: 'partner',
            uiPath: `/partner/${encodeURIComponent(partner.slug)}/season/${encodeURIComponent(seasonCode)}/subscribe`,
            apiPath: `${req.baseUrl||''}${req.path}`
          }
        : { flow: 'subscription', uiPath: seasonPath, apiPath: `${req.baseUrl||''}${req.path}` },
      mailTemplateKind: 'subscription',
      locale: req.locale,
      meta: {
        seasonCode,
        seasonName: season?.name || null,
        source: partner ? 'partner-season-subscription' : 'season-subscription',
        ...partnerMeta
      }
    });

    // HOLD des sièges réels (status available -> busy + meta.hold)
    const holdUntil = new Date(Date.now() + HOLD_MS);
    holdExpiresAt = holdUntil;
    const realSeatIds = lines
      .map(l => String(l.seatId || '').trim())
      .filter(sid => sid && !isVirtualZoneSeatId(sid));

      if (realSeatIds.length) {
      // Pose les holds uniquement sur les sièges encore disponibles
      const upd = await Seat.updateMany(
        { seasonCode, venueSlug, seatId: { $in: realSeatIds }, status: 'available' },
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
        // Rollback strict : ne libère que ce qu'on vient de tenir pour CETTE commande
        await Seat.updateMany(
          {
            seasonCode, venueSlug,
            seatId: { $in: realSeatIds },
            status: 'busy',
            $or: [
              { 'meta.hold.orderId': String(order._id) },
              { 'meta.hold.orderId': order._id } // compat si des holds anciens sont typés ObjectId
            ]
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
        return res.status(409).json({ ok:false, error:'seat_unavailable', message:'Un des sièges vient d’être pris.' });
      }
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
      console.error('[subscription] createCheckoutIntent failed:', error);
      return res.status(502).json({ error: 'payment_unavailable' });
    }
    const checkoutId = String(intent?.id || intent?.checkoutReference || raw?.id || raw?.checkout_reference || '');
    if (checkoutId) {
      const checkoutReference = raw?.checkout_reference || intent?.checkoutReference || checkoutId;
      const tokenHash = makeTokenHash({ orderId: order._id, checkoutIntentId: checkoutId });
      order.paymentProviderMeta = {
        ...(order.paymentProviderMeta || {}),
        name: PAYMENT_PROVIDER_ID,
        checkoutIntentId: checkoutId,
        checkoutReference,
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

    // holdExpiresAt : le front affiche le décompte « Places réservées pendant ».
    // Sans lui, l'acheteur ne sait pas combien de temps ses places lui sont
    // gardées pendant qu'il paie — et un abandon silencieux ressemble à un bug.
    return res.json({
      ok: true,
      orderId: order._id,
      totalCents,
      redirectUrl: buildPayStartUrl(order._id),   // repli hérité
      providerUrl: redirectUrl,                    // page de paiement du prestataire
      statusUrl:   buildPayStatusUrl(order._id),   // polling
      returnUrl:   buildPayReturnUrl(order._id, checkoutId),
      holdExpiresAt
    });
  } catch (e) {
    const code = e.status || 500;
    console.error('[POST /api/season/checkout] error:', e);
    return res.status(code).json({ error: e.message || 'internal_error' });
  }
});

export default router;
