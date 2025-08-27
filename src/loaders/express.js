// src/loaders/express.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import compression from 'compression';
import cors from 'cors';

// 👉 IMPORTANT : chemin racine du repo (pas /src)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const rootDir    = path.resolve(__dirname, '..');  // /src → racine projet

import routes from '../routes/index.js';           // ← depuis /src/loaders vers /src/routes

export async function buildApp() {
  const app = express();

  app.use(compression());
  app.use(cors({ origin: '*', credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // --- Statics ---
  app.use('/public', express.static(path.join(rootDir, 'public'), { fallthrough: true }));
  app.use('/views',  express.static(path.join(rootDir, 'views'),  { fallthrough: true }));

  // --- Routes applicatives ---
  routes(app);  // monte /renew (HTML) + /s/renew (JSON) etc.

  // 404 JSON par défaut
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.originalUrl });
  });

  // Handler erreurs
  app.use((err, req, res, _next) => {
    console.error('[error]', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  });

  return app;
}
