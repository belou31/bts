// src/routes/index.js
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import renewApi from './renew.js';
import haRouter from './ha.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const rootDir    = path.resolve(__dirname, '..');

export default function routes(app) {
  const router = express.Router();

  // Page HTML
  router.get('/renew', (_req, res) => {
    res.sendFile(path.join(rootDir, 'views', 'renew', 'index.html'));
  });

  // API JSON sous /s (GET /s/renew, POST /s/renew)
  router.use('/s', renewApi);

  // Retour paiement HelloAsso
  router.use('/', haRouter);

  // Santé
  router.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.use('/', router);
}
