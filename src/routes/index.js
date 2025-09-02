// src/routes/index.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import renewApi from './renew.js';   // <- API: GET/POST /s/renew …

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const VIEWS_DIR  = path.resolve(__dirname, '..', 'views');

export default function routes(router) {
  // Page HTML "renew"
  router.get('/renew', (req, res) => {
    const filePath = path.join(VIEWS_DIR, 'renew', 'index.html');
    res.sendFile(filePath);
  });

  // API sous /s
  router.use('/s', renewApi);

  // Page racine -> redirige vers /renew (optionnel)
  router.get('/', (_req, res) => res.redirect('./renew'));
}
