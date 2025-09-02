// src/routes/index.js
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

import renewApi    from './renew.js';
import haRouter    from './ha.js';
import debugRouter from './debug.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const SRC_DIR    = path.resolve(__dirname, '..'); // pointe sur /src

export default function routes(r) {
  const router = r instanceof express.Router ? r : express.Router();

  // HEAD pour les checks (curl -I)
  router.head('/renew', (_req, res) => res.status(200).end());

  // Page HTML renew
  router.get('/renew', (_req, res) => {
    res.sendFile(path.join(SRC_DIR, 'views', 'renew', 'index.html'));
  });

  // API JSON sous /s
  router.use('/s', renewApi);

  // HelloAsso (retours)
  router.use('/', haRouter);

  // Debug
  if (debugRouter) router.use('/', debugRouter);

  return router;
}
