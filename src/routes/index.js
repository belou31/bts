// src/routes/index.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import { currentPaymentProviderLabel } from '../services/payments/index.js';

import renewApi from './renew.js';   // <- API: GET/POST /s/renew …
import tbh7Router from './tbh7.js';
import subscriptionRouter from './subscription.js';
import eventRoutes from './event.js';
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
        customJs: ['static/js/subscription.js']
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
  router.get('/event/:ev', (req, res) => {
    const eventKey = String(req.params.ev || '').trim();
    if (!eventKey) return res.status(400).send('Missing event slug');

    const encodedKey = encodeURIComponent(eventKey);
    const baseForJoin = BASE_PATH || '/';
    const statusPath = path.posix.join(baseForJoin, 'api/event', encodedKey, 'status');
    const checkoutPath = path.posix.join(baseForJoin, 'api/event', encodedKey, 'checkout');

    // ⚠️ Comme on est sous /event/<slug>, utiliser des endpoints RELATIFS remontant d’un cran ("../")
    // pour viser /api/... (et pas /event/api/...)
    const providerName = currentPaymentProviderLabel();

    res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
      title:   'Billetterie Match — Valence 11/10/2025' ,
      heading: 'Billetterie Match',
      lead:    `Choisissez vos places pour ce match et suivez le paiement sécurisé ${providerName}.`,
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
          // ✅ endpoints absolus (compat /bts) — pas de préfixe /event/
          status: statusPath,
          checkout: checkoutPath
        },
        selection: { type: 'seats' },
        buildRowsFromData: false,
        svgSeatClasses: { allowed: 'seat-allowed' }
      },
      orderPageConfig: { focusField: 'payerEmail' },
      // ✅ script spécifique en chemin absolu
      customJs: [ ASSET_PREFIX + 'js/event.js' ]
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

  router.use('/control/scan', scanRoutes);
  router.use('/control/guestlist', controlGuestlistRoutes);

  // API sous /s
  router.use('/s', renewApi);


  // ✨ Routes paiement (return, back, error, webhook)
  router.use('/pay', payRoutes);                 // expose /pay/return, /pay/back, /pay/error

  // Page racine -> redirige vers /renew (optionnel)
  //router.get('/', (_req, res) => res.redirect('./renew'));
}
import { Season } from '../models/Season.js';
