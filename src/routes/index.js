// src/routes/index.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import renewApi from './renew.js';   // <- API: GET/POST /s/renew …
import tbh7Router from './tbh7.js';
import haRoutes from './ha.js';      

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const VIEWS_DIR  = path.resolve(__dirname, '..', 'views');

export default function routes(router) {
  // Page HTML "renew"
  router.get('/renew', (req, res) => {
    const filePath = path.join(VIEWS_DIR, 'renew', 'index.html');
    res.sendFile(filePath);
  });

  // Page HTML
  router.get('/tbh7', (req, res) => res.sendFile(path.join(VIEWS_DIR, 'tbh7', 'index.html')));

  // API JSON
  router.use('/api/tbh7', tbh7Router);

  // API sous /s
  router.use('/s', renewApi);


  // ✨ Routes HelloAsso (retour, back, error)
  router.use('/', haRoutes);                 //  expose /ha/return, /ha/back, /ha/error

  // Page racine -> redirige vers /renew (optionnel)
  router.get('/', (_req, res) => res.redirect('./renew'));
}
