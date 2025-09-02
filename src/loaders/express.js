// src/loaders/express.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import compression from 'compression';
import cors from 'cors';

import routes from '../routes/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const SRC_DIR    = path.resolve(__dirname, '..');

function computeBasePath() {
  const fromEnv = (process.env.BASE_PATH || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const appUrl = (process.env.APP_URL || '').trim();
  try {
    if (!appUrl) return '';
    const u = new URL(appUrl);
    return (u.pathname || '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

export async function buildApp() {
  const app = express();
  const basePath = computeBasePath();
  console.log('[server] basePath =', JSON.stringify(basePath || ''));

  app.use(compression());
  app.use(cors({ origin: '*', credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // ---------- Statics ----------
  app.use(
    path.posix.join(basePath, '/static'),
    express.static(path.join(SRC_DIR, 'public', 'static'), {
      fallthrough: true,
      maxAge: '7d',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=UTF-8');
        if (filePath.endsWith('.js'))  res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
        if (filePath.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml; charset=UTF-8');
        if (filePath.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
        if (filePath.endsWith('.ico')) res.setHeader('Content-Type', 'image/x-icon');
      }
    })
  );

  app.use(
    path.posix.join(basePath, '/static/venues'),
    express.static(path.join(SRC_DIR, 'public', 'venues'), {
      fallthrough: true,
      maxAge: '7d',
      setHeaders: (res) => res.setHeader('Content-Type', 'image/svg+xml; charset=UTF-8')
    })
  );

  app.use(
    path.posix.join(basePath, '/static/views'),
    express.static(path.join(SRC_DIR, 'views'), {
      fallthrough: true,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js'))  res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
        if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=UTF-8');
      }
    })
  );

  // ---------- Routes applicatives ----------
  console.log('[server] calling routes(router)…');
  const handedRouter = express.Router();
  let returnedRouter = null;
  try {
    returnedRouter = await routes(handedRouter);
    console.log('[server] routes() executed. handedRouter.stack =', handedRouter.stack?.length ?? 0,
                'returnedRouter.stack =', returnedRouter?.stack?.length ?? 'n/a');
  } catch (e) {
    console.error('[server] routes() FAILED:', e);
  }

  // Si routes() renvoie un autre Router, on monte celui-là
  const toMount = (returnedRouter && typeof returnedRouter.use === 'function')
    ? returnedRouter
    : handedRouter;

  app.use(basePath || '/', toMount);
  console.log('[server] app.use(router) mounted at', JSON.stringify(basePath || '/'),
              'with', toMount.stack?.length ?? 0, 'handlers');

  // Dump complet (y compris routers imbriqués)
  function dumpRoutes(app) {
    const walk = (prefix, stack) => {
      stack.forEach(layer => {
        if (layer.route) {
          const methods = Object.keys(layer.route.methods).join('|').toUpperCase();
          console.log('[route]', methods, prefix + layer.route.path);
        } else if (layer.name === 'router' && layer.handle?.stack) {
          walk(prefix, layer.handle.stack);
        }
      });
    };
    console.log('[server] dumping routes…');
    walk('', app._router.stack);
  }
  dumpRoutes(app);

  // ---------- Health ----------
  app.get(path.posix.join(basePath || '/', '/healthz'), (_req, res) => res.json({ ok: true }));

  // ---------- 404 JSON ----------
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.originalUrl });
  });

  return app;
}
