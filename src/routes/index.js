// src/routes/index.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import renewApi from './renew.js';   // <- API: GET/POST /s/renew …
import tbh7Router from './tbh7.js';
import subscriptionRouter from './subscription.js';
import eventRoutes from './event.js';
import adminRoutes from './admin.js';
import supervisionRoutes from './admin/supervision.routes.js';
import haRoutes from './ha.js';      
import adminGuestlist from './admin-guestlist.js';
import qrRoutes   from './qr.js';
import scanRoutes from './scan.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const VIEWS_DIR  = path.resolve(__dirname, '..', 'views');

export default function routes(router) {
  // Page HTML "renew"
  router.get('/renew', (req, res) => {
    const qsIndex = req.originalUrl.indexOf('?');
    const suffix = qsIndex >= 0 ? req.originalUrl.slice(qsIndex) : '';

    res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
      title: 'Renouvellement d’abonnement — BTS',
      heading: 'Renouvellement d’abonnement',
      lead: 'Renouvelez votre abonnement pour conserver vos sièges et accéder à l’ensemble des rencontres à domicile de la saison 2025-2026.',
      planHelp: 'Cliquez sur votre siège pour le renouveler. Les zones TBH7 et Debout restent accessibles via le plan.',
      scheduleOptions: null,
      paymentHelp: 'Le reçu HelloAsso et la confirmation d’abonnement seront envoyés à l’email de contact.',
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

  router.get('/subscription', (_req, res) => {

    res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
      title: 'Abonnements — BTS',
      heading: 'Abonnements Saison 2025-2026',
      lead: "L'abonnement donne accès à tous les matchs à domicile des Bélougas D2, D3 et Féminin Elite, pour la saison régulière, les playoffs et les matchs amicaux.",
      planHelp: 'Cliquez sur un siège ou utilisez le sélecteur de zone TBH7 / Debout pour ajouter des places.',
      scheduleOptions: [1, 2, 3],
      zoneSelector: {
        enabled: true,
        label: 'Choisir sur Plan ou Ajouter Zone:',
        addLabel: 'Ajouter',
        options: []
      },
      paymentHelp: "Le reçu HelloAsso et la confirmation d’abonnement seront envoyés à l’email de contact.",
      config: {
        title: 'Les Bélougas - Abonnements 2025-2026',
        api: {
          status: 'api/sub/status',
          checkout: 'api/sub/checkout'
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
  });

  router.get('/event', (req, res) => {
    const eventKey = String(req.query.eventId || req.query.slug || '').trim();
    if (!eventKey) {
      return res.status(400).send('Missing eventId parameter');
    }

    const encodedKey = encodeURIComponent(eventKey);

    res.render(path.resolve(VIEWS_DIR, 'order', 'index'), {
      title: 'Billetterie Match — BTS',
      heading: 'Billetterie Match',
      lead: 'Choisissez vos places pour ce match et suivez le tunnel de paiement sécurisé HelloAsso.',
      planHelp: 'Cliquez sur un siège disponible ou ajoutez des places en zone Debout lorsque proposé.',
      scheduleOptions: [1],
      paymentHelp: 'Vous recevrez un email de confirmation avec vos billets une fois le paiement validé.',
      config: {
        api: {
          status: `../api/event/${encodedKey}/status`,
          checkout: `../api/event/${encodedKey}/checkout`
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


  router.use(`/api`, qrRoutes);
  router.use(`/`,    scanRoutes);  // sert /scan (PWA)

  // API JSON
  router.use('/api/tbh7', tbh7Router);

  router.use('/api/sub', subscriptionRouter);

  router.use('/api/event', eventRoutes);

  router.use('/admin', adminRoutes);

  router.use('/admin/supervision', supervisionRoutes);

  router.use('/', adminGuestlist); // donne /bts/admin/event/:eventIdOrSlug/guestlist

  // API sous /s
  router.use('/s', renewApi);


  // ✨ Routes HelloAsso (retour, back, error)
  router.use('/ha', haRoutes);                 //  expose /ha/return, /ha/back, /ha/error

  // Page racine -> redirige vers /renew (optionnel)
  //router.get('/', (_req, res) => res.redirect('./renew'));
}
