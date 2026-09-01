// src/routes/index.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';

import { currentPaymentProviderLabel } from '../services/payments/index.js';
import { Event } from '../models/Event.js';
import { Season } from '../models/Season.js';
import { Venue } from '../models/Venue.js';
import { Order } from '../models/Order.js';
import { loadCustomization, resolveOrganizationName } from '../services/customization.js';
import { formatDate } from '../utils/format.js';
import { getPartnerConfig } from '../config/partners.js';
import { isEventOnSale, isEventSaleLocked } from '../utils/event-sale.js';
import { seasonDoorStatus } from '../utils/season-sale.js';
import { resolveSeasonSubscribeAccess, seasonAccessMessage } from '../services/season-access.js';

import renewApi from './renew.js';   // <- API: GET/POST /s/renew …
import seatChangeApi from './seat-change.js';   // <- API: GET/POST /s/seat-change
import voucherApi from './voucher.js';          // <- API: /s/voucher, /s/voucher/event/:slug, /s/voucher/redeem
import subscriptionRouter from './subscription.js';
import eventRoutes from './event.js';
import partnerRoutes, { adminRouter as partnerAdminRouter } from './partner.js';
import adminRoutes from './admin/index.js';
import supervisionRoutes from './admin/supervision.routes.js';
import renewersRoutes from './admin/renewers.routes.js';
import adminVouchersRoutes from './admin/vouchers.routes.js';
import payRoutes from './pay.js';      
import controlGuestlistRoutes from './control/guestlist.js';
import qrRoutes   from './qr.js';
import promoRoutes from './promo.js';
import scanRoutes from './control/scan.js';
import automationRoutes from './automation/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const VIEWS_DIR  = path.resolve(__dirname, '..', 'views');

const tmpl = (s, vars = {}) => {
  if (!s) return '';
  return String(s).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
};


// Préfixes d'URL (utilisés par la vue EJS "order")
// IMPORTANT : en DEV BASE_PATH == '' -> les assets statiques restent sous /static, les médias mutables sous /dynamic
const BASE_PATH = (process.env.BASE_PATH || '').trim();
const STATIC_PREFIX = path.posix.join(BASE_PATH, '/static/').replace(/\/{2,}/g, '/');
const DYNAMIC_PREFIX = path.posix.join(BASE_PATH, '/dynamic/').replace(/\/{2,}/g, '/');
const MEDIA_PREFIX = path.posix.join(DYNAMIC_PREFIX, 'assets/').replace(/\/{2,}/g, '/');
const VENUES_PREFIX = path.posix.join(DYNAMIC_PREFIX, 'venues/').replace(/\/{2,}/g, '/');
const ASSETS_BASE = { static: STATIC_PREFIX, media: MEDIA_PREFIX, venues: VENUES_PREFIX, base: DYNAMIC_PREFIX };
const PARTNER_FRAME_ANCESTORS = (process.env.PARTNER_FRAME_ANCESTORS || '').trim();
function expectedPartnerToken(cfg, eventSlug) {
  if (!cfg) return null;
  if (cfg.tokens?.events && eventSlug && cfg.tokens.events[eventSlug]) {
    return cfg.tokens.events[eventSlug];
  }
  return cfg.accessToken || null;
}

function applyPartnerFrameAncestorsHeaders(res, overrideList) {
  const list = (Array.isArray(overrideList) && overrideList.length)
    ? overrideList
    : (PARTNER_FRAME_ANCESTORS ? PARTNER_FRAME_ANCESTORS.split(/\s+/).filter(Boolean) : null);

  if (list && list.length) {
    const value = list.join(' ');
    res.setHeader('Content-Security-Policy', `frame-ancestors ${value}`);
    const firstOrigin = list[0];
    if (firstOrigin) {
      const normalized = firstOrigin.toLowerCase();
      if (normalized === "'self'" || normalized === 'self') {
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      } else if (normalized === "'none'" || normalized === 'none') {
        res.setHeader('X-Frame-Options', 'DENY');
      } else {
        res.setHeader('X-Frame-Options', `ALLOW-FROM ${firstOrigin}`);
      }
    }
  } else {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
}

const isObjectIdLike = (value) => /^[0-9a-fA-F]{24}$/.test(String(value || '').trim());

async function resolveEventByKey(key) {
  const raw = String(key || '').trim();
  if (!raw) return null;
  const query = isObjectIdLike(raw)
    ? { $or: [{ _id: raw }, { slug: raw }] }
    : { slug: raw };
  return Event.findOne(query).lean();
}

function formatEventDateLabel(startsAt, locale) {
  if (!startsAt) return '';
  return formatDate(startsAt, locale, {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris'
  });
}


// Message honnête plutôt qu'un 404 muet : le visiteur doit pouvoir distinguer
// « pas encore ouvert » de « c'est fini » — et le club, comprendre quel levier
// il lui manque (publish-season.js).
function seasonGateMessage(reason, door) {
  const labels = { renew: 'Le renouvellement', subscribe: 'L\'abonnement' };
  const what = labels[door] || 'La vente';
  switch (reason) {
    case 'season_not_found':     return 'Saison introuvable.';
    case 'season_archived':      return 'Cette saison est archivée.';
    case 'season_not_published': return `${what} n'est pas encore ouvert.`;
    case `${door}_notopen`:      return `${what} n'est pas encore ouvert.`;
    case `${door}_closed`:       return `${what} est clos pour cette saison.`;
    default:                     return `${what} n'est pas accessible.`;
  }
}

export default function routes(router) {
  // Page HTML "renew"
  // Ancien chemin, conservé : des liens /renew?id=… sont déjà partis par mail et
  // imprimés. On résout la saison depuis le jeton et on redirige vers le chemin
  // explicite, plutôt que de casser ce qui circule.
  router.get('/renew', async (req, res) => {
    const token = String(req.query.id || '').trim();
    if (token && process.env.JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded?.seasonCode) {
          const target = path.posix.join(BASE_PATH || '/', 'season',
            encodeURIComponent(decoded.seasonCode), 'renew') + `?id=${encodeURIComponent(token)}`;
          return res.redirect(302, target);
        }
      } catch { /* jeton illisible : on retombe sur la page générique ci-dessous */ }
    }
    return renderRenewPage(req, res, null);
  });

  // Chemin explicite.
  router.get('/season/:seasonCode/renew', async (req, res) => {
    const code = String(req.params.seasonCode || '').trim();
    const season = await Season.findOne({ $or: [{ code }, { seasonCode: code }] }).lean();
    const gate = seasonDoorStatus(season, 'renew');
    if (!gate.open) return res.status(gate.reason === 'season_not_found' ? 404 : 403).send(seasonGateMessage(gate.reason, 'renew'));
    return renderRenewPage(req, res, season);
  });

  // Renouvellement d'un bénéficiaire PARTENAIRE.
  //
  // Le partenaire fait autorité par le JETON, jamais par l'URL : le segment
  // /partner/<slug>/ n'est qu'un habillage, et une URL qui désignerait un autre
  // partenaire que le jeton est refusée. Sans ce contrôle, n'importe quel
  // renouveleur s'attribuerait les tarifs réservés d'un partenaire en éditant
  // son propre lien — ces tarifs existent précisément pour ne pas être publics.
  router.get('/partner/:partnerSlug/season/:seasonCode/renew', async (req, res) => {
    const urlPartner = String(req.params.partnerSlug || '').trim().toLowerCase();
    const code = String(req.params.seasonCode || '').trim();

    const partnerCfg = getPartnerConfig(urlPartner);
    if (!partnerCfg) return res.status(404).send('Partner not found');
    if (!isOriginAllowed(req, partnerCfg.allowedOrigins)) {
      return res.status(403).send('Access restricted for this partner.');
    }
    applyPartnerFrameAncestorsHeaders(res, partnerCfg.frameAncestors);

    const token = String(req.query.id || '').trim();
    let tokenPartner = null;
    if (token && process.env.JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        tokenPartner = decoded?.partnerSlug ? String(decoded.partnerSlug).toLowerCase() : null;
      } catch { /* jeton illisible : traité comme absent ci-dessous */ }
    }
    if (tokenPartner !== urlPartner) {
      return res.status(403).send(
        "Ce lien de renouvellement n'est pas rattaché à ce partenaire."
      );
    }

    const season = await Season.findOne({ $or: [{ code }, { seasonCode: code }] }).lean();
    const gate = seasonDoorStatus(season, 'renew');
    if (!gate.open) {
      return res.status(gate.reason === 'season_not_found' ? 404 : 403)
        .send(seasonGateMessage(gate.reason, 'renew'));
    }
    return renderRenewPage(req, res, season, partnerCfg);
  });

  async function renderRenewPage(req, res, seasonDoc, partnerCfg = null) {
    const providerName = currentPaymentProviderLabel();
    const qsIndex = req.originalUrl.indexOf('?');
    const suffix = qsIndex >= 0 ? req.originalUrl.slice(qsIndex) : '';

    // The season isn't known server-side otherwise — it's only carried inside
    // the renewal JWT (?id=), same token decoded by src/routes/renew.js.
    let seasonName = seasonDoc?.name || '';
    const token = String(req.query.id || '').trim();
    if (!seasonName && token && process.env.JWT_SECRET) {
      // Chemin hérité (/renew sans saison résolue) : le code de saison n'est
      // porté que par le jeton.
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded?.seasonCode) {
          const fromToken = await Season.findOne({ code: decoded.seasonCode }).lean().catch(() => null);
          seasonName = fromToken?.name || decoded.seasonCode;
        }
      } catch { /* invalid/expired token: fall back to season-agnostic copy below */ }
    }
    // Habillage partenaire : mêmes clés que partout ailleurs (subscription.*),
    // avec la couche partners/<slug>.json par-dessus — voir customization.js.
    const partnerSlug = partnerCfg?.slug || '';
    const customization = loadCustomization({
      seasonCode: seasonDoc?.code || seasonDoc?.seasonCode || '',
      partnerSlug,
      locale: req.locale
    });
    const tmplVars = {
      seasonCode: seasonDoc?.code || seasonDoc?.seasonCode || '',
      seasonName: seasonName || '',
      partnerSlug,
      partnerName: partnerCfg?.name || partnerSlug
    };

    const defaultLead = seasonName
      ? `Renouvelez votre abonnement pour conserver vos sièges et accéder à l’ensemble des rencontres à domicile de la ${seasonName}.`
      : 'Renouvelez votre abonnement pour conserver vos sièges et accéder à l’ensemble des rencontres à domicile.';
    // Le chapô partenaire (« billetterie réservée aux ayants-droits de X »)
    // reste juste sur une page de renouvellement : on le reprend.
    const lead = partnerCfg && customization['subscription.lead']
      ? tmpl(customization['subscription.lead'], tmplVars)
      : defaultLead;
    // Le TITRE, lui, ne se reprend pas : subscription.title annonce un
    // « Abonnement », alors que cette page renouvelle un abonnement existant.
    // Il n'existe pas de clé renew.title ; on compose donc le nom du partenaire
    // avec le libellé de renouvellement plutôt que d'afficher un intitulé faux.
    const heading = partnerCfg
      ? `${partnerCfg.name || partnerSlug} — Renouvellement d’abonnement`
      : 'Renouvellement d’abonnement';

    const renewApiPath = path.posix.join(BASE_PATH || '/', 's', 'renew') + suffix;

    res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
      // La vue ajoute déjà « — BTS » : le répéter ici donnait « … — BTS — BTS ».
      title: partnerCfg
        ? `${partnerCfg.name || partnerSlug} — Renouvellement`
        : 'Renouvellement d’abonnement',
      heading,
      lead,
      planHelp: 'Cliquez sur votre siège pour le renouveler. Les zones TBH7 et Debout restent accessibles via le plan.',
      scheduleOptions: null,
      // Une place supplémentaire peut être prise en zone debout, pas seulement
      // sur un siège numéroté : sans ce bloc, order/index.ejs ne rend pas le
      // conteneur #zoneButtons et renew.js n'a nulle part où poser les boutons.
      zoneSelector: {
        enabled: true,
        label: 'Choisir sur le plan ou ajouter une place en zone :',
        addLabel: 'Ajouter',
        options: []
      },
      paymentHelp: `Le reçu ${providerName} et la confirmation d’abonnement seront envoyés à l’email de contact.`,
      assets: ASSETS_BASE,
      config: {
        api: {
          // Chemin ABSOLU, pas relatif.
          //
          // `s/renew` fonctionnait tant que la page vivait à /renew : le
          // navigateur le résolvait contre la racine. Depuis le passage au
          // chemin explicite /season/<code>/renew, il se résout contre
          // /season/<code>/ et vise /season/<code>/s/renew — d'où un 404 au
          // chargement du plan. Les autres vues construisent déjà leurs
          // chemins avec path.posix.join(BASE_PATH, …) pour cette raison.
          status: renewApiPath,
          checkout: renewApiPath
        },
        selection: { type: 'seats' },
        // Le panier ne se déduit plus des sièges renvoyés : /s/renew expose
        // désormais TOUTE la salle (nécessaire pour changer de place), donc
        // laisser generic-view.js pré-remplir depuis `seats` mettrait le stade
        // entier dans le panier. renew.js n'y met que les sièges du renouveleur.
        buildRowsFromData: false
      },
      orderPageConfig: {
        focusField: 'payerEmail'
      },
      // Standing-zone renewal lines (e.g. "FAN_ZONE-Z001") have no SVG seat
      // element to click, so renew.js (customJs below) adds them to the cart
      // automatically instead of requiring a click. See public/static/js/renew.js.
      customJs: [STATIC_PREFIX + 'js/renew.js']
    });
  }

  // /season/<code> reste un point d'entrée naturel : on l'envoie vers le chemin
  // explicite plutôt que d'y servir silencieusement la page d'abonnement.
  router.get('/season/:seasonCode', (req, res) => {
    const code = String(req.params.seasonCode || '').trim();
    const qs = req.originalUrl.indexOf('?') >= 0 ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    return res.redirect(302, path.posix.join(BASE_PATH || '/', 'season', encodeURIComponent(code), 'subscribe') + qs);
  });

  router.get('/season/:seasonCode/subscribe', async (req, res, next) => {
    try {
      const rawSeason = String(req.params.seasonCode || '').trim();
      if (!rawSeason) return res.status(400).send('Season code required');

      const seasonDoc = await Season.findOne({
        $or: [{ code: rawSeason }, { seasonCode: rawSeason }]
      }).lean();
      if (!seasonDoc) return res.status(404).send('Season not found');

      const gate = seasonDoorStatus(seasonDoc, 'subscribe');
      if (!gate.open) return res.status(403).send(seasonGateMessage(gate.reason, 'subscribe'));

      const seasonCode = seasonDoc.code || seasonDoc.seasonCode || rawSeason;
      const seasonName = seasonDoc.name || `Saison ${seasonCode}`;
      const providerName = currentPaymentProviderLabel();
      const venueSlug = seasonDoc.venueSlug || seasonDoc.venue || '';
      const venueDoc = venueSlug ? await Venue.findOne({ slug: venueSlug }).lean().catch(() => null) : null;
      const customization = loadCustomization({ seasonCode, locale: req.locale });
      const tmplVars = {
        seasonCode,
        seasonName,
        venueSlug,
        venueName: venueDoc?.name || venueSlug || ''
      };

      const encodedSeason = encodeURIComponent(seasonCode);
      const baseForJoin = BASE_PATH || '/';
      const statusPath = path.posix.join(baseForJoin, 'api/season', encodedSeason, 'status');
      const checkoutPath = path.posix.join(baseForJoin, 'api/season', encodedSeason, 'checkout');

      const headingCustom = Boolean(customization['subscription.title']);
      const heading = headingCustom
        ? tmpl(customization['subscription.title'], tmplVars)
        : `Abonnements ${seasonCode}`;
      const lead = customization['subscription.lead']
        ? tmpl(customization['subscription.lead'], tmplVars)
        : "L'abonnement donne accès à tous les matchs à domicile des Bélougas D2, D3 et Féminin Elite, pour la saison régulière, les playoffs et les matchs amicaux.";
      const planHelp = customization['subscription.help']
        ? tmpl(customization['subscription.help'], tmplVars)
        : 'Cliquez sur un siège ou utilisez le sélecteur de zone TBH7 / Debout pour ajouter des places.';
      const payButtonLabel = customization['subscription.payButton']
        ? tmpl(customization['subscription.payButton'], tmplVars)
        : undefined;
      const pageTitle = headingCustom ? heading : `Abonnements ${seasonCode}`;
      const documentTitle = `Billetterie — ${pageTitle}`;

      res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
        title: `Abonnements — ${seasonName}`,
        documentTitle,
        heading,
        lead,
        planHelp,
        scheduleOptions: [1, 2, 3],
        zoneSelector: {
          enabled: true,
          label: 'Choisir sur Plan ou Ajouter Zone:',
          addLabel: 'Ajouter',
          options: []
        },
        paymentHelp: `Le reçu ${providerName} et la confirmation d’abonnement seront envoyés à l’email de contact.`,
        assets: ASSETS_BASE,
        config: {
          title: `Les Bélougas - Abonnements ${seasonCode}`,
          seasonCode,
          seasonName,
          api: {
            status: statusPath,
            checkout: checkoutPath
          },
          selection: { type: 'seats' },
          buildRowsFromData: false,
          svgSeatClasses: { allowed: 'seat-allowed' },
          headingCustom
        },
        headingCustom,
        payButtonLabel,
        orderPageConfig: {
          focusField: 'payerEmail'
        },
        customJs: [STATIC_PREFIX + 'js/subscription.js']
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/subscription', async (_req, res, next) => {
    try {
      // Saison courante = la seule publiée dont l'abonnement est ouvert.
      // (Remplace `{ isActive: true }`, qui portait sur un champ inexistant :
      // strictQuery le supprimait et renvoyait une saison arbitraire.)
      const seasonDoc = await Season.findOne({ activity: 'active', subscribe: 'open' }).lean();
      if (!seasonDoc) return res.status(503).send('Aucune saison n\'est ouverte à l\'abonnement.');
      const code = seasonDoc.code || seasonDoc.seasonCode;
      const target = path.posix.join(BASE_PATH || '/', 'season', encodeURIComponent(code), 'subscribe');
      return res.redirect(target);
    } catch (err) {
      next(err);
    }
  });

  // NEW: route "slug" (/event/:ev) – recommandée
  router.get('/event/:ev', async (req, res, next) => {
    try {
      const eventKey = String(req.params.ev || '').trim();
      if (!eventKey) return res.status(400).send('Missing event slug');

      const ev = await resolveEventByKey(eventKey);
      if (!ev) return res.status(404).send('Event not found');

      const slug = ev.slug || eventKey;
      const encodedKey = encodeURIComponent(slug);
      const baseForJoin = BASE_PATH || '/';
      const statusPath = path.posix.join(baseForJoin, 'api/event', encodedKey, 'status');
      const checkoutPath = path.posix.join(baseForJoin, 'api/event', encodedKey, 'checkout');
      const providerName = currentPaymentProviderLabel();
      const customization = loadCustomization({ eventSlug: slug, seasonCode: ev.seasonCode, locale: req.locale });
      const venueDoc = ev.venueSlug ? await Venue.findOne({ slug: ev.venueSlug }).lean().catch(() => null) : null;
      const tmplVars = {
        eventName: ev.name || slug,
        eventSlug: slug,
        seasonCode: ev.seasonCode || '',
        venueSlug: ev.venueSlug || '',
        venueName: venueDoc?.name || ev.venueSlug || '',
        eventStartsAt: ev.startsAt || '',
        eventStartsAtFormatted: formatEventDateLabel(ev.startsAt, req.locale) || ''
      };

      const t = res.locals.t;
      const eventNameForCopy = ev.name || t('event.genericMatchName');
      const dateLabel = formatEventDateLabel(ev.startsAt, req.locale);
      const venueLabel = venueDoc?.name || (ev.venueSlug || '').replace(/[-_]/g, ' ').trim();
      const headingCustom = Boolean(customization['event.title']);
      const heading = headingCustom
        ? tmpl(customization['event.title'], tmplVars)
        : t('event.documentTitle', { eventName: eventNameForCopy });
      const leadPieces = [];
      if (ev.description) leadPieces.push(ev.description);
      if (dateLabel) leadPieces.push(t('event.leadKickoff', { date: dateLabel }));
      if (venueLabel) leadPieces.push(t('event.leadVenue', { venue: venueLabel }));
      if (!leadPieces.length) {
        leadPieces.push(t('event.leadGeneric', { provider: providerName }));
      }
      const leadText = customization['event.lead']
        ? tmpl(customization['event.lead'], tmplVars)
        : leadPieces.join(' · ');
      const planHelpText = customization['event.help']
        ? tmpl(customization['event.help'], tmplVars)
        : t('event.planHelpDefault');
      const payButtonLabel = customization['event.payButton']
        ? tmpl(customization['event.payButton'], tmplVars)
        : undefined;

      res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
        title: t('event.pageTitle', { eventName: eventNameForCopy }),
        documentTitle: t('event.documentTitle', { eventName: eventNameForCopy }),
        heading,
        lead: leadText,
        planHelp: planHelpText,
        scheduleOptions: [],
        paymentHelp: t('event.paymentHelp'),
        assets: ASSETS_BASE,
        zoneSelector: {
          enabled: true,
          label: t('event.zoneSelectorLabel'),
          addLabel: t('common.add'),
          options: []
        },
        config: {
          api: {
            status: statusPath,
            checkout: checkoutPath
          },
          selection: { type: 'seats' },
          buildRowsFromData: false,
          svgSeatClasses: { allowed: 'seat-allowed' },
          event: {
            id: String(ev._id),
            slug,
            name: ev.name,
            startsAt: ev.startsAt,
            venueSlug: ev.venueSlug
          },
          headingCustom
        },
        headingCustom,
        orderPageConfig: { focusField: 'payerEmail' },
        customJs: [STATIC_PREFIX + 'js/event.js'],
        payButtonLabel
      });
    } catch (err) {
      next(err);
    }
  });

  // Abonné : changement de place pour UN match, depuis le mail de billets.
  // La page ne fait que porter le plan ; tout est validé par /s/seat-change.
  router.get('/seat-change', (req, res) => {
    const token = String(req.query.id || '').trim();
    if (!token) return res.status(400).send('Missing token');
    const statusPath = path.posix.join(BASE_PATH || '/', 's', 'seat-change') +
      `?id=${encodeURIComponent(token)}`;

    // Vue de commande partagée : on ne veut d'elle que le plan (zoom,
    // déplacement, plein écran, bascule de disposition). `sidePanel` remplace
    // la colonne panier/paiement par la liste des places de l'abonné.
    res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
      title: 'Changer de place — BTS',
      heading: 'Changer de place',
      planHelp: 'Sélectionnez la place à changer à droite, puis cliquez sa nouvelle position sur le plan.',
      // Chemin absolu : un include EJS se résout sinon depuis le dossier de la
      // vue qui inclut (ici src/views/order/).
      sidePanel: path.resolve(VIEWS_DIR, 'seat-change', 'panel'),
      scheduleOptions: null,
      showSchedule: false,
      assets: ASSETS_BASE,
      config: {
        api: { status: statusPath, checkout: statusPath },
        selection: { type: 'seats' },
        // Aucun panier ici : les lignes sont rendues par le panneau latéral.
        buildRowsFromData: false,
        seatChange: { api: statusPath }
      },
      orderPageConfig: {},
      customJs: [STATIC_PREFIX + 'js/seat-change.js']
    });
  });


  // ——— Bons cadeaux (retrait par le bénéficiaire) ———
  // Le QR imprimé mène ici : solde + matchs éligibles.
  router.get('/voucher', async (req, res) => {
    const token = String(req.query.id || '').trim();
    if (!token) return res.status(400).send('Missing token');
    try {
      const { loadVoucherByToken, voucherUsability, remainingOf, listEligibleEvents,
              allowanceForEvent, usedOnEvent } = await import('../services/vouchers.js');
      const voucher = await loadVoucherByToken(token);
      if (!voucher) return res.status(404).send('Bon introuvable ou lien invalide.');

      const usable = voucherUsability(voucher);
      const reasonText = {
        voucher_expired: 'Ce bon a expiré.',
        voucher_spent: 'Ce bon a déjà été entièrement utilisé.',
        voucher_suspended: 'Ce bon est momentanément suspendu. Contactez le club.',
        voucher_canceled: 'Ce bon a été annulé.'
      }[usable.reason] || 'Ce bon n’est pas utilisable.';

      const evs = usable.ok ? await listEligibleEvents(voucher) : [];
      const base = BASE_PATH || '/';
      const events = evs.map(ev => ({
        slug: ev.slug,
        name: ev.name || ev.slug,
        startsAt: ev.startsAt,
        allowance: allowanceForEvent(voucher, ev.slug),
        alreadyTaken: usedOnEvent(voucher, ev.slug),
        link: path.posix.join(base, 'voucher', encodeURIComponent(ev.slug)) + `?id=${encodeURIComponent(token)}`
      }));

      res.render(path.resolve(VIEWS_DIR, 'voucher-events'), {
        title: 'Votre invitation',
        assets: ASSETS_BASE,
        brand: { logo: path.posix.join(ASSETS_BASE.media, 'logo.svg'), alt: resolveOrganizationName() },
        usable: usable.ok,
        reasonText,
        voucher: {
          code: voucher.code, label: voucher.label || '',
          remaining: remainingOf(voucher),
          total: Number(voucher.balance?.total || 0),
          used: Number(voucher.balance?.used || 0),
          maxPerEvent: Number(voucher.maxPerEvent || 0),
          expiresAt: voucher.expiresAt || null
        },
        events
      });
    } catch (err) {
      console.error('[voucher] error:', err?.message || err);
      res.status(500).send('Error loading voucher');
    }
  });

  // Achat d'un bon (amont). DÉCLARÉ AVANT /voucher/:eventSlug, sinon "buy"
  // serait pris pour un slug de match.
  router.get('/voucher/buy', async (req, res) => {
    const { loadPurchaseConfig } = await import('../services/vouchers.js');
    const cfg = loadPurchaseConfig();
    res.render(path.resolve(VIEWS_DIR, 'voucher-buy'), {
      title: 'Offrir des places',
      assets: ASSETS_BASE,
      brand: { logo: path.posix.join(ASSETS_BASE.media, 'logo.svg'), alt: resolveOrganizationName() },
      cfg,
      apiPath: path.posix.join(BASE_PATH || '/', 's', 'voucher', 'purchase')
    });
  });

  // Choix des places pour UN match : même écran que la billetterie (plan
  // zoomable), colonne de droite remplacée par le panneau du bon.
  router.get('/voucher/:eventSlug', (req, res) => {
    const token = String(req.query.id || '').trim();
    const eventSlug = String(req.params.eventSlug || '').trim();
    if (!token || !eventSlug) return res.status(400).send('Missing token or event');
    const base = BASE_PATH || '/';
    const statusPath = path.posix.join(base, 's', 'voucher', 'event', encodeURIComponent(eventSlug)) +
      `?id=${encodeURIComponent(token)}`;
    const redeemPath = path.posix.join(base, 's', 'voucher', 'redeem') + `?id=${encodeURIComponent(token)}`;

    res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
      title: 'Votre invitation — choisir vos places',
      heading: 'Choisir vos places',
      planHelp: 'Cliquez les places souhaitées sur le plan, dans la limite de votre invitation.',
      sidePanel: path.resolve(VIEWS_DIR, 'voucher', 'panel'),
      scheduleOptions: null,
      showSchedule: false,
      assets: ASSETS_BASE,
      config: {
        api: { status: statusPath, checkout: redeemPath },
        selection: { type: 'seats' },
        buildRowsFromData: false,
        voucher: { redeem: redeemPath, eventSlug }
      },
      orderPageConfig: {},
      customJs: [STATIC_PREFIX + 'js/voucher.js']
    });
  });

  // Public: list all events, open ones link straight to /event/:slug
  router.get('/events', async (req, res) => {
    try {
      const events = await Event.find({ activity: 'active' }).sort({ startsAt: 1 }).lean();
      const list = events.map(ev => {
        const status = isEventOnSale(ev) ? 'sale_opened' : (ev.sale === 'soldout' ? 'sold_out' : 'sale_closed');
        const link = status === 'sale_opened'
          ? path.posix.join(BASE_PATH || '/', 'event', ev.slug)
          : null;
        return {
          slug: ev.slug,
          name: ev.name || ev.slug,
          startsAt: ev.startsAt,
          status,
          link
        };
      });

      if (req.accepts('json') && !req.accepts('html')) {
        return res.json({ ok: true, events: list });
      }

      const brandLogo = path.posix.join(ASSETS_BASE.media, 'logo.svg');

      res.render(path.resolve(VIEWS_DIR, 'events'), {
        title: 'Événements — BTS',
        events: list,
        assets: ASSETS_BASE,
        brand: { logo: brandLogo, alt: resolveOrganizationName() }
      });
    } catch (err) {
      console.error('[events] error:', err?.message || err);
      res.status(500).send('Error loading events');
    }
  });

  // Partner: list available events with shared token
  router.get('/partner/:partnerSlug/events', async (req, res) => {
    try {
      const partnerSlug = String(req.params.partnerSlug || '').trim();
      if (!partnerSlug) return res.status(400).send('Missing partner slug');
      const partnerCfg = getPartnerConfig(partnerSlug);
      if (!partnerCfg) return res.status(404).send('Partner not found');

      const providedToken = (req.query?.token || '').trim();
      const expectedGlobalToken = expectedPartnerToken(partnerCfg, null);
      if (expectedGlobalToken && providedToken !== expectedGlobalToken) {
        return res.status(403).send('Access restricted for this partner.');
      }
      if (!isOriginAllowed(req, partnerCfg.allowedOrigins)) {
        return res.status(403).send('Access restricted for this partner.');
      }

      applyPartnerFrameAncestorsHeaders(res, partnerCfg.frameAncestors);

      const events = await Event.find({}).sort({ startsAt: 1 }).lean();
      const list = [];
      for (const ev of events) {
        const quota = Number(partnerCfg?.presale?.events?.[ev.slug]?.quota || 0);
        let remaining = null;
        if (quota > 0) {
          const usedAgg = await Order.aggregate([
            { $match: { eventId: ev._id, 'meta.partner.slug': partnerSlug, status: { $nin: ['canceled', 'failed'] } } },
            { $unwind: '$lines' },
            { $group: { _id: null, qty: { $sum: { $ifNull: ['$lines.qty', { $ifNull: ['$lines.quantity', 1] }] } } } }
          ]);
          const used = usedAgg?.[0]?.qty || 0;
          remaining = Math.max(0, quota - used);
        }
        const status = (() => {
          if (isEventOnSale(ev)) return 'sale_opened';
          if (ev.sale === 'soldout') return 'sold_out';
          if (!isEventSaleLocked(ev) && quota > 0) {
            if (remaining !== null && remaining <= 0) return 'presale_quota_reached';
            return 'presale_opened';
          }
          return 'sale_closed';
        })();
        const expectedToken = expectedPartnerToken(partnerCfg, ev.slug);
        const sameToken = !expectedToken || expectedToken === providedToken;
        const link = (sameToken && status !== 'sale_closed' && status !== 'presale_quota_reached' && status !== 'sold_out')
          ? path.posix.join(BASE_PATH || '/', 'partner', partnerSlug, 'event', ev.slug) +
              (providedToken ? `?token=${encodeURIComponent(providedToken)}` : '')
          : null;
        list.push({
          slug: ev.slug,
          name: ev.name || ev.slug,
          startsAt: ev.startsAt,
          status,
          presaleQuota: quota,
          presaleRemaining: remaining,
          link,
          tokenMatch: sameToken
        });
      }

      if (req.accepts('json') && !req.accepts('html')) {
        return res.json({ ok: true, partner: partnerSlug, events: list });
      }

      const brandLogo = path.posix.join(ASSETS_BASE.media, 'logo.svg');

      res.render(path.resolve(VIEWS_DIR, 'events'), {
        title: `${partnerCfg.name || partnerSlug} — Événements`,
        partner: partnerCfg,
        events: list,
        assets: ASSETS_BASE,
        brand: { logo: brandLogo, alt: partnerCfg.name || partnerSlug }
      });
    } catch (err) {
      console.error('[partner/events] error:', err?.message || err);
      res.status(500).send('Error loading partner events');
    }
  });

  // Abonnement saison vendu par un partenaire.
  //
  // Pendant de /partner/:slug/event/:slug, mais côté saison : la page est la
  // même vue partenaire, branchée sur l'API d'abonnement au lieu de celle des
  // événements. Le quota, lui, se compte en ABONNEMENTS et non en places —
  // voir services/partner-presale.js.
  // Même forme que le public : /partner/<slug>/season/<code> renvoie vers le
  // chemin explicite. Un partenaire n'a aujourd'hui qu'une porte (l'abonnement),
  // mais nommer l'action dans l'URL vaut aussi ici — c'est ce qui permettra
  // d'en ajouter une autre sans que l'ancienne URL change de sens.
  router.get('/partner/:partnerSlug/season/:seasonCode', (req, res) => {
    const slug = String(req.params.partnerSlug || '').trim();
    const code = String(req.params.seasonCode || '').trim();
    const qs = req.originalUrl.indexOf('?') >= 0 ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    return res.redirect(302, path.posix.join(
      BASE_PATH || '/', 'partner', encodeURIComponent(slug), 'season', encodeURIComponent(code), 'subscribe'
    ) + qs);
  });

  router.get('/partner/:partnerSlug/season/:seasonCode/subscribe', async (req, res, next) => {
    try {
      const partnerSlug = String(req.params.partnerSlug || '').trim();
      const seasonParam = String(req.params.seasonCode || '').trim();
      if (!partnerSlug || !seasonParam) return res.status(400).send('Missing partner or season code');

      const partnerCfg = getPartnerConfig(partnerSlug);
      if (!partnerCfg) return res.status(404).send('Partner not found');

      // Même garde que le flux événement : jeton global du partenaire.
      const expectedToken = expectedPartnerToken(partnerCfg, null);
      const providedToken = (req.query?.token || '').trim();
      if (expectedToken && providedToken !== expectedToken) {
        return res.status(403).send('Access restricted for this partner.');
      }
      if (!isOriginAllowed(req, partnerCfg.allowedOrigins)) {
        return res.status(403).send('Access restricted for this partner.');
      }
      applyPartnerFrameAncestorsHeaders(res, partnerCfg.frameAncestors);

      const seasonDoc = await Season.findOne({
        $or: [{ code: seasonParam }, { seasonCode: seasonParam }]
      }).lean();
      if (!seasonDoc) return res.status(404).send('Season not found');

      const seasonCode = seasonDoc.code || seasonDoc.seasonCode || seasonParam;
      const seasonName = seasonDoc.name || `Saison ${seasonCode}`;
      const venueSlug = seasonDoc.venueSlug || seasonDoc.venue || '';

      // Même règle que l'API (services/season-access.js) : sans quoi la page
      // s'ouvrirait sur un formulaire qui échouerait au paiement.
      const access = await resolveSeasonSubscribeAccess({
        season: seasonDoc, seasonCode, partnerCfg, partnerSlug
      });
      if (!access.allowed) {
        return res.status(403).send(seasonAccessMessage(access.reason));
      }
      const quota = access.partner?.quota || 0;
      const remaining = access.partner?.remaining ?? null;
      const doorOpen = seasonDoorStatus(seasonDoc, 'subscribe').open;

      const providerName = currentPaymentProviderLabel();
      const venueDoc = venueSlug ? await Venue.findOne({ slug: venueSlug }).lean().catch(() => null) : null;
      const customization = loadCustomization({ seasonCode, partnerSlug, locale: req.locale });
      const tmplVars = {
        seasonCode, seasonName, venueSlug,
        venueName: venueDoc?.name || venueSlug || '',
        partnerSlug,
        partnerName: partnerCfg.name || partnerSlug
      };

      const encodedPartner = encodeURIComponent(partnerSlug);
      const encodedSeason = encodeURIComponent(seasonCode);
      const baseForJoin = BASE_PATH || '/';
      const tokenSuffix = providedToken ? `?token=${encodeURIComponent(providedToken)}` : '';
      const statusPath = path.posix.join(baseForJoin, 'api/partner', encodedPartner, 'season', encodedSeason, 'status') + tokenSuffix;
      const checkoutPath = path.posix.join(baseForJoin, 'api/partner', encodedPartner, 'season', encodedSeason, 'checkout') + tokenSuffix;

      // Vue de salle : préférence saison du partenaire, puis sa vue par défaut.
      const seasonsMap = partnerCfg?.venueViews?.seasons || {};
      const resolvedVenueView =
        seasonsMap[seasonCode] || seasonsMap[seasonCode.toLowerCase()] || partnerCfg.venueView || null;

      const partnerOptions = {
        slug: partnerCfg.slug,
        invoiceMode: partnerCfg.paymentMode === 'psp' ? 'psp' : 'invoice',
        reserveApi: null,
        payButtonLabel: customization['subscription.payButton'] || partnerCfg?.reserve?.payButtonLabel
          || (partnerCfg.paymentMode === 'psp' ? 'Procéder au paiement' : 'Envoyer la demande'),
        successMessage: partnerCfg?.reserve?.successMessage || 'Demande envoyée. Vous recevrez une confirmation prochainement.',
        errorMessage: partnerCfg?.reserve?.errorMessage || 'Impossible d’enregistrer votre demande. Réessayez.'
      };

      const headingCustom = Boolean(customization['subscription.title']);
      const heading = headingCustom
        ? tmpl(customization['subscription.title'], tmplVars)
        : `${partnerCfg.name || partnerSlug} — Abonnements ${seasonCode}`;
      const lead = customization['subscription.lead']
        ? tmpl(customization['subscription.lead'], tmplVars)
        : (partnerCfg?.ui?.lead || `Réservez vos abonnements ${seasonName} via la billetterie dédiée partenaire.`);
      const planHelp = customization['subscription.help']
        ? tmpl(customization['subscription.help'], tmplVars)
        : 'Sélectionnez un siège sur le plan ou ajoutez des places en zone.';
      const isInvoiceMode = partnerCfg.paymentMode !== 'psp';
      const paymentHelp = partnerCfg?.ui?.paymentHelp ||
        (isInvoiceMode
          ? 'Demande enregistrée puis facturation différée. Aucun paiement en ligne n’est requis.'
          : `Paiement sécurisé ${providerName}.`);

      res.render(path.resolve(VIEWS_DIR, 'partner', 'index'), {
        title: `${partnerCfg.name || 'Billetterie Partenaire'} — Abonnements ${seasonCode}`,
        heading,
        lead,
        planHelp,
        scheduleOptions: [1, 2, 3],
        paymentHelp,
        assets: ASSETS_BASE,
        zoneSelector: {
          enabled: true,
          label: 'Choisir sur Plan ou Ajouter Zone:',
          addLabel: 'Ajouter',
          options: []
        },
        config: {
          title: `${partnerCfg.name || partnerSlug} — Abonnements ${seasonCode}`,
          seasonCode,
          seasonName,
          api: { status: statusPath, checkout: checkoutPath, reserve: null },
          selection: { type: 'seats' },
          buildRowsFromData: false,
          svgSeatClasses: { allowed: 'seat-allowed' },
          venueView: resolvedVenueView,
          partnerSlug,
          partner: partnerOptions,
          presale: { quota, remaining, active: quota > 0 && !doorOpen },
          headingCustom
        },
        headingCustom,
        payButtonLabel: partnerOptions.payButtonLabel,
        orderPageConfig: { focusField: 'payerEmail' },
        customJs: [STATIC_PREFIX + 'js/subscription.js'],
        partnerOptions
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/partner/:partnerSlug/event/:eventSlug', async (req, res) => {
    const partnerSlug = String(req.params.partnerSlug || '').trim();
    const eventSlug = String(req.params.eventSlug || '').trim();
    if (!partnerSlug || !eventSlug) return res.status(400).send('Missing partner or event slug');

    const partnerCfg = getPartnerConfig(partnerSlug);
    if (!partnerCfg) {
      return res.status(404).send('Partner not found');
    }

    const expectedToken = expectedPartnerToken(partnerCfg, eventSlug);
    const providedToken = (req.query?.token || '').trim();
    if (expectedToken && providedToken !== expectedToken) {
      return res.status(403).send('Access restricted for this partner.');
    }

    if (!isOriginAllowed(req, partnerCfg.allowedOrigins)) {
      return res.status(403).send('Access restricted for this partner.');
    }

    applyPartnerFrameAncestorsHeaders(res, partnerCfg.frameAncestors);

    const providerName = currentPaymentProviderLabel();
    const ev = await resolveEventByKey(eventSlug).catch(() => null);
    const venueDoc = ev?.venueSlug ? await Venue.findOne({ slug: ev.venueSlug }).lean().catch(() => null) : null;
    const customization = loadCustomization({ eventSlug, seasonCode: ev?.seasonCode, partnerSlug, locale: req.locale });
    const tmplVars = {
      eventName: ev?.name || eventSlug,
      eventSlug,
      seasonCode: ev?.seasonCode || '',
      venueSlug: ev?.venueSlug || '',
      venueName: venueDoc?.name || ev?.venueSlug || '',
      eventStartsAt: ev?.startsAt || '',
      eventStartsAtFormatted: formatEventDateLabel(ev?.startsAt, req.locale) || '',
      partnerSlug,
      partnerName: partnerCfg.name || partnerSlug
    };
    const encodedPartner = encodeURIComponent(partnerSlug);
    const encodedEvent = encodeURIComponent(eventSlug);
    const baseForJoin = BASE_PATH || '/';
    const tokenSuffix = providedToken ? `?token=${encodeURIComponent(providedToken)}` : '';
    const statusPath = path.posix.join(baseForJoin, 'api/partner', encodedPartner, 'event', encodedEvent, 'status') + tokenSuffix;
    const checkoutPath = path.posix.join(baseForJoin, 'api/partner', encodedPartner, 'event', encodedEvent, 'checkout') + tokenSuffix;
    const reservePath = partnerCfg.paymentMode !== 'psp'
      ? path.posix.join(baseForJoin, 'api/partner', encodedPartner, 'event', encodedEvent, 'reserve') + tokenSuffix
      : null;

    const slugKey = ev?.slug || eventSlug || '';
    const nameKey = ev?.name || '';
    const lowerSlug = slugKey.toLowerCase();
    const lowerName = nameKey.toLowerCase();
    const eventsMap = partnerCfg?.venueViews?.events || {};
    const seasonsMap = partnerCfg?.venueViews?.seasons || {};
    const eventView =
      eventsMap[slugKey] ||
      eventsMap[nameKey] ||
      eventsMap[lowerSlug] ||
      eventsMap[lowerName] ||
      null;
    const seasonKey = ev?.seasonCode || ev?.season || '';
    const lowerSeason = seasonKey.toLowerCase();
    const seasonView =
      seasonsMap[seasonKey] ||
      seasonsMap[lowerSeason] ||
      null;
    const resolvedVenueView = eventView || seasonView || partnerCfg.venueView || null;

    const partnerOptions = {
      slug: partnerCfg.slug,
      invoiceMode: partnerCfg.paymentMode === 'psp' ? 'psp' : 'invoice',
      reserveApi: reservePath,
      payButtonLabel: customization['event.payButton'] || partnerCfg?.reserve?.payButtonLabel || (partnerCfg.paymentMode === 'psp' ? 'Procéder au paiement' : 'Envoyer la demande'),
      successMessage: partnerCfg?.reserve?.successMessage || 'Demande envoyée. Vous recevrez une confirmation prochainement.',
      errorMessage: partnerCfg?.reserve?.errorMessage || 'Impossible d’enregistrer votre demande. Réessayez.'
    };

    const heading = customization['event.title']
      ? tmpl(customization['event.title'], tmplVars)
      : (partnerCfg?.ui?.heading || 'Accès Partenaire');
    const lead = customization['event.lead']
      ? tmpl(customization['event.lead'], tmplVars)
      : (partnerCfg?.ui?.lead || 'Réservez vos places via la billetterie dédiée partenaire.');
    const planHelp = customization['event.help']
      ? tmpl(customization['event.help'], tmplVars)
      : 'Sélectionnez un siège disponible ou ajoutez des places en zone Debout lorsque proposé.';
    const headingCustom = Boolean(customization['event.title']);
    const isInvoiceMode = partnerCfg.paymentMode !== 'psp';
    const paymentHelp = partnerCfg?.ui?.paymentHelp ||
      (isInvoiceMode
        ? 'Demande enregistrée puis facturation différée. Aucun paiement en ligne n’est requis.'
        : `Paiement sécurisé ${providerName}.`);

    res.render(path.resolve(VIEWS_DIR, 'partner', 'index'), {
      title: `${partnerCfg.name || 'Billetterie Partenaire'} — BTS`,
      heading,
      lead,
      planHelp,
      scheduleOptions: [],
      paymentHelp,
      assets: ASSETS_BASE,
      zoneSelector: {
        enabled: true,
        label: 'Choisir sur Plan ou Ajouter Zone:',
        addLabel: 'Ajouter',
        options: []
      },
      config: {
        api: {
          status: statusPath,
          checkout: checkoutPath,
          reserve: reservePath
        },
        selection: { type: 'seats' },
        buildRowsFromData: false,
        svgSeatClasses: { allowed: 'seat-allowed' },
        venueView: resolvedVenueView,
        partnerSlug,
        eventSlug,
        partner: partnerOptions,
        headingCustom
      },
      payButtonLabel: partnerOptions.payButtonLabel,
      orderPageConfig: { focusField: 'payerEmail' },
      customJs: [STATIC_PREFIX + 'js/event.js'],
      partnerOptions
    });
  });

  // Legacy: /event?eventId=<slug> – conservé pour compat
  router.get('/event', (req, res) => {

  const eventKey = String(req.query.eventId || req.query.slug || '').trim();
    if (!eventKey) {
      return res.status(400).send('Missing eventId parameter');
    }

    const providerName = currentPaymentProviderLabel();
    const encodedKey = encodeURIComponent(eventKey);
    const baseForJoin = BASE_PATH || '/';
    const statusPath = path.posix.join(baseForJoin, 'api/event', encodedKey, 'status');
    const checkoutPath = path.posix.join(baseForJoin, 'api/event', encodedKey, 'checkout');

    res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
      title: 'Billetterie Match — BTS',
      heading: 'Billetterie Match',
      lead: `Choisissez vos places pour ce match et suivez le tunnel de paiement sécurisé ${providerName}.`,
      planHelp: 'Cliquez sur un siège disponible ou ajoutez des places en zone Debout lorsque proposé.',
      scheduleOptions: [1],
      paymentHelp: 'Vous recevrez un email de confirmation avec vos billets une fois le paiement validé.',
      assets: ASSETS_BASE,
      config: {
        api: {
          // La version legacy reste au niveau /event (pas de sous-dossier), on peut rester en relatif simple
          status:  statusPath,
          checkout: checkoutPath
        },
        selection: { type: 'seats' },
        buildRowsFromData: false,
        svgSeatClasses: { allowed: 'seat-allowed' }
      },
      orderPageConfig: {
        focusField: 'payerEmail'
      },
      zoneSelector: {
        enabled: true,
        label: 'Zones debout disponibles :'
      },
      customJs: [STATIC_PREFIX + 'js/event.js']
    });
  });


  router.use('/api/automation', automationRoutes);


  router.use(`/api`, qrRoutes);

  // API JSON
  router.use('/api/partner', partnerRoutes);
  // Partner admin CSV/JSON
  router.use('/partner', partnerAdminRouter);

  router.use('/api/season/:seasonCode', subscriptionRouter);
  router.use('/api/season', subscriptionRouter);
  router.use('/api/sub', (req, res, next) => {
    req.params = req.params || {};
    if (!req.params.seasonCode) {
      req.params.seasonCode = req.query?.season || req.query?.seasonCode || '';
    }
    return subscriptionRouter(req, res, next);
  });

  router.use('/api/event', eventRoutes);

  router.use('/admin', adminRoutes);

  router.use('/admin/supervision', supervisionRoutes);

  router.use('/admin/renewers', renewersRoutes);
  router.use('/admin/vouchers', adminVouchersRoutes);

  router.use('/', scanRoutes);
  router.use('/', controlGuestlistRoutes);

  // Sponsor promo QR redirect (trackable) — see src/routes/promo.js
  router.use('/promo', promoRoutes);

  // API sous /s
  router.use('/s', renewApi);
  router.use('/s', seatChangeApi);   // GET/POST /s/seat-change
  router.use('/s', voucherApi);      // bons cadeaux


  // ✨ Routes paiement (return, back, error, webhook)
  router.use('/pay', payRoutes);                 // expose /pay/return, /pay/back, /pay/error

// Page racine -> redirige vers /renew (optionnel)
//router.get('/', (_req, res) => res.redirect('./renew'));
}
function extractRequestOrigins(req) {
  const origins = [];
  const origin = req.get('origin');
  if (origin) origins.push(origin);
  const referer = req.get('referer');
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      origins.push(refererOrigin);
    } catch {}
  }
  return origins.filter(Boolean);
}

function isOriginAllowed(req, allowedList) {
  const list = Array.isArray(allowedList) ? allowedList.filter(Boolean) : [];
  if (!list.length) return true;
  const origins = extractRequestOrigins(req).map(o => o.toLowerCase());
  if (!origins.length) return false;
  return origins.some(origin => list.some(allowed => origin === allowed.toLowerCase()));
}
