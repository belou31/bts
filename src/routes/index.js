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

  // Page HTML
  router.get('/tbh7', (req, res) => res.sendFile(path.join(VIEWS_DIR, 'tbh7', 'index.html')));

  router.get('/subscription', (req, res) => res.sendFile(path.join(VIEWS_DIR, 'subscription', 'index.html')));

  router.get('/event', (req, res) => res.sendFile(path.join(VIEWS_DIR, 'event', 'index.html')));

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
