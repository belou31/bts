// src/routes/index.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import { currentPaymentProviderLabel } from '../services/payments/index.js';
import { Event } from '../models/Event.js';
import { Season } from '../models/Season.js';

import renewApi from './renew.js';   // <- API: GET/POST /s/renew …
import tbh7Router from './tbh7.js';
import subscriptionRouter from './subscription.js';
import eventRoutes from './event.js';
import partnerRoutes, { adminRouter as partnerAdminRouter } from './partner.js';
import adminRoutes from './admin/index.js';
import supervisionRoutes from './admin/supervision.routes.js';
import payRoutes from './pay.js';      
import controlGuestlistRoutes from './control/guestlist.js';
import qrRoutes   from './qr.js';
import scanRoutes from './control/scan.js';
import automationRoutes from './automation/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const VIEWS_DIR  = path.resolve(__dirname, '..', 'views');


// Préfixes d'URL (utilisés par la vue EJS "order")
// IMPORTANT : en DEV BASE_PATH == '' -> assets doit commencer par /static (absolu)
const BASE_PATH = (process.env.BASE_PATH || '').trim();
const ASSET_PREFIX = path.posix.join(BASE_PATH, '/static/').replace(/\/{2,}/g, '/');
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

function formatEventDateLabel(startsAt) {
  if (!startsAt) return '';
  const dt = new Date(startsAt);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('fr-FR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris'
  });
}


export default function routes(router) {
  // Page HTML "renew"
  router.get('/renew', (req, res) => {
    const providerName = currentPaymentProviderLabel();
    const qsIndex = req.originalUrl.indexOf('?');
    const suffix = qsIndex >= 0 ? req.originalUrl.slice(qsIndex) : '';

    res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
      title: 'Renouvellement d’abonnement — BTS',
      heading: 'Renouvellement d’abonnement',
      lead: 'Renouvelez votre abonnement pour conserver vos sièges et accéder à l’ensemble des rencontres à domicile de la saison 2025-2026.',
      planHelp: 'Cliquez sur votre siège pour le renouveler. Les zones TBH7 et Debout restent accessibles via le plan.',
      scheduleOptions: null,
      paymentHelp: `Le reçu ${providerName} et la confirmation d’abonnement seront envoyés à l’email de contact.`,
      assets: ASSET_PREFIX,
      config: {
        api: {
          status: `s/renew${suffix}`,
          checkout: `s/renew${suffix}`
        },
        selection: { type: 'seats' }
      },
      orderPageConfig: {
        focusField: 'payerEmail'
      }
    });
  });

  router.get('/season/:seasonCode', async (req, res, next) => {
    try {
      const rawSeason = String(req.params.seasonCode || '').trim();
      if (!rawSeason) return res.status(400).send('Season code required');

      const seasonDoc = await Season.findOne({
        $or: [{ code: rawSeason }, { seasonCode: rawSeason }]
      }).lean();
      if (!seasonDoc) return res.status(404).send('Season not found');

      const seasonCode = seasonDoc.code || seasonDoc.seasonCode || rawSeason;
      const seasonName = seasonDoc.name || `Saison ${seasonCode}`;
      const providerName = currentPaymentProviderLabel();

      const encodedSeason = encodeURIComponent(seasonCode);
      const baseForJoin = BASE_PATH || '/';
      const statusPath = path.posix.join(baseForJoin, 'api/season', encodedSeason, 'status');
      const checkoutPath = path.posix.join(baseForJoin, 'api/season', encodedSeason, 'checkout');

      res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
        title: `Abonnements — ${seasonName}`,
        heading: `Abonnements ${seasonCode}`,
        lead: "L'abonnement donne accès à tous les matchs à domicile des Bélougas D2, D3 et Féminin Elite, pour la saison régulière, les playoffs et les matchs amicaux.",
        planHelp: 'Cliquez sur un siège ou utilisez le sélecteur de zone TBH7 / Debout pour ajouter des places.',
        scheduleOptions: [1, 2, 3],
        zoneSelector: {
          enabled: true,
          label: 'Choisir sur Plan ou Ajouter Zone:',
          addLabel: 'Ajouter',
          options: []
        },
        paymentHelp: `Le reçu ${providerName} et la confirmation d’abonnement seront envoyés à l’email de contact.`,
        assets: ASSET_PREFIX,
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
          svgSeatClasses: { allowed: 'seat-allowed' }
        },
        orderPageConfig: {
          focusField: 'payerEmail'
        },
        customJs: [ASSET_PREFIX + 'js/subscription.js']
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/subscription', async (_req, res, next) => {
    try {
      const seasonDoc = await Season.findOne({ isActive: true }).lean();
      if (!seasonDoc) return res.status(503).send('No active season');
      const code = seasonDoc.code || seasonDoc.seasonCode;
      const target = path.posix.join(BASE_PATH || '/', 'season', encodeURIComponent(code));
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

      const dateLabel = formatEventDateLabel(ev.startsAt);
      const venueLabel = (ev.venueSlug || '').replace(/[-_]/g, ' ').trim().toUpperCase();
      const heading = ev.name ? `Billetterie — ${ev.name}` : 'Billetterie Match';
      const leadPieces = [];
      if (ev.description) leadPieces.push(ev.description);
      if (dateLabel) leadPieces.push(`Coup d’envoi : ${dateLabel}`);
      if (venueLabel) leadPieces.push(`Lieu : ${venueLabel}`);
      if (!leadPieces.length) {
        leadPieces.push(`Choisissez vos places pour ce match et suivez le paiement sécurisé ${providerName}.`);
      }

      res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
        title: `Billetterie Match — ${ev.name || slug}`,
        documentTitle: `Billetterie — ${ev.name || 'Match BTS'}`,
        heading,
        lead: leadPieces.join(' · '),
        planHelp: 'Cliquez sur un siège disponible ou ajoutez des places en zone Debout lorsque proposé.',
        scheduleOptions: [],
        paymentHelp: 'Vous recevrez un email de confirmation avec vos billets une fois le paiement validé.',
        assets: ASSET_PREFIX,
        zoneSelector: {
          enabled: true,
          label: 'Choisir sur Plan ou Ajouter Zone:',
          addLabel: 'Ajouter',
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
          }
        },
        orderPageConfig: { focusField: 'payerEmail' },
        customJs: [ASSET_PREFIX + 'js/event.js']
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/partner/:partnerSlug/event/:eventSlug', (req, res) => {
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
    const encodedPartner = encodeURIComponent(partnerSlug);
    const encodedEvent = encodeURIComponent(eventSlug);
    const baseForJoin = BASE_PATH || '/';
    const tokenSuffix = providedToken ? `?token=${encodeURIComponent(providedToken)}` : '';
    const statusPath = path.posix.join(baseForJoin, 'api/partner', encodedPartner, 'event', encodedEvent, 'status') + tokenSuffix;
    const checkoutPath = path.posix.join(baseForJoin, 'api/partner', encodedPartner, 'event', encodedEvent, 'checkout') + tokenSuffix;
    const reservePath = partnerCfg.paymentMode !== 'psp'
      ? path.posix.join(baseForJoin, 'api/partner', encodedPartner, 'event', encodedEvent, 'reserve') + tokenSuffix
      : null;

    const partnerOptions = {
      slug: partnerCfg.slug,
      invoiceMode: partnerCfg.paymentMode === 'psp' ? 'psp' : 'invoice',
      reserveApi: reservePath,
      payButtonLabel: partnerCfg?.reserve?.payButtonLabel || (partnerCfg.paymentMode === 'psp' ? 'Procéder au paiement' : 'Envoyer la demande'),
      successMessage: partnerCfg?.reserve?.successMessage || 'Demande envoyée. Vous recevrez une confirmation prochainement.',
      errorMessage: partnerCfg?.reserve?.errorMessage || 'Impossible d’enregistrer votre demande. Réessayez.'
    };

    const heading = partnerCfg?.ui?.heading || 'Accès Partenaire';
    const lead = partnerCfg?.ui?.lead || 'Réservez vos places via la billetterie dédiée partenaire.';
    const isInvoiceMode = partnerCfg.paymentMode !== 'psp';
    const paymentHelp = partnerCfg?.ui?.paymentHelp ||
      (isInvoiceMode
        ? 'Demande enregistrée puis facturation différée. Aucun paiement en ligne n’est requis.'
        : `Paiement sécurisé ${providerName}.`);

    res.render(path.resolve(VIEWS_DIR, 'partner', 'index'), {
      title: `${partnerCfg.name || 'Billetterie Partenaire'} — BTS`,
      heading,
      lead,
      planHelp: 'Sélectionnez un siège disponible ou ajoutez des places en zone Debout lorsque proposé.',
      scheduleOptions: [],
      paymentHelp,
      assets: ASSET_PREFIX,
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
        venueView: partnerCfg.venueView || null,
        partnerSlug,
        eventSlug,
        partner: partnerOptions
      },
      payButtonLabel: partnerOptions.payButtonLabel,
      orderPageConfig: { focusField: 'payerEmail' },
      customJs: [ASSET_PREFIX + 'js/event.js'],
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
      assets: ASSET_PREFIX,
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
      customJs: ['static/js/event.js']
    });
  });


  router.get('/tbh7', (_req, res) => {
  
    res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
      title: 'TBH7 — Abonnements Fan Club',
      heading: 'Abonnements TBH7',
      lead: 'Rejoignez le fan club TBH7 : choisissez votre zone dédiée et finalisez votre inscription en quelques clics.',
      planHelp: 'Sélectionnez votre zone TBH7 directement sur le plan ou via les boutons dédiés.',
      scheduleOptions: [1, 2, 3],
      paymentHelp: 'Un email de confirmation vous sera envoyé dès validation du paiement.',
      assets: ASSET_PREFIX,
      config: {
        title: 'TBH7 — Fan Club',
        api: {
          status: 'api/tbh7/status',
          checkout: 'api/tbh7/checkout'
        },
        selection: { type: 'zones' },
        buildRowsFromData: false,
        svgSeatClasses: { allowed: 'seat-allowed' }
      },
      orderPageConfig: {
        focusField: 'payerEmail'
      }
    });
  });

  router.use('/api/automation', automationRoutes);


  router.use(`/api`, qrRoutes);

  // API JSON
  router.use('/api/tbh7', tbh7Router);

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

  router.use('/', scanRoutes);
  router.use('/', controlGuestlistRoutes);

  // API sous /s
  router.use('/s', renewApi);


  // ✨ Routes paiement (return, back, error, webhook)
  router.use('/pay', payRoutes);                 // expose /pay/return, /pay/back, /pay/error

// Page racine -> redirige vers /renew (optionnel)
//router.get('/', (_req, res) => res.redirect('./renew'));
}
import { getPartnerConfig } from '../config/partners.js';
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
