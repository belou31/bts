// src/loaders/express.js
import express from 'express';
import path from 'path';
import compression from 'compression';
import cors from 'cors';
import { fileURLToPath } from 'url';

import routes from '../routes/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export async function buildApp() {
  const app = express();

  const BASE_PATH = (process.env.BASE_PATH || '').trim();   // ex: "", ou "/bts"
  const HOST = process.env.HOST || '127.0.0.1';
  const PORT = Number(process.env.PORT || 8080);

  // Middlewares
  app.disable('x-powered-by');
  app.use(compression());
  app.use(cors({ origin: '*', credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Healthz
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Statiques (toujours sous /static, préfixés par BASE_PATH côté frontal)
  const STATIC_DIR = path.resolve(__dirname, '..', 'public', 'static');
  //const STATIC_DIR = path.resolve(process.cwd(), 'public', 'static');
  
  app.use(path.posix.join(BASE_PATH, '/static'), express.static(STATIC_DIR, {
    fallthrough: false,
    maxAge: '1h',
    extensions: ['html', 'js', 'css', 'png', 'svg', 'ico']
  }));

  // Favicon direct (facultatif)
  app.get(path.posix.join(BASE_PATH, '/favicon.ico'), (req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'img', 'favicon.ico'));
  });

  // Router applicatif monté **sous BASE_PATH**
  const router = express.Router();
  routes(router);                       // <-- déclare /renew et /s/…
  app.use(BASE_PATH || '/', router);

  // 404 JSON pour API
  app.use((req, res, next) => {
    if (req.path.startsWith(path.posix.join(BASE_PATH, '/s/'))) {
      return res.status(404).json({ error: 'Not found', path: req.path });
    }
    return next();
  });

  // 404 générique (HTML)
  app.use((_req, res) => {
    res.status(404).send('<h1>404 Not Found</h1>');
  });

  // Démarrage si appelé directement
  //if (import.meta.url === `file://${__filename}`) {
  //  app.listen(PORT, HOST, () => {
  //    console.log(`[server] basePath = "${BASE_PATH}"`);
  //    console.log(`[server] listening on http://${HOST}:${PORT}`);
  //  });
  //}

  return app;
}
