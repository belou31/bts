// src/routes/scan.js (ESM)
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Ticket } from '../models/Ticket.js';
import { ScanLog } from '../models/ScanLog.js';
import { verifySignature } from '../services/qr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function basePath() {
  // "" en DEV, "/bts" en INT/PROD (ou ce que tu définis)
  return process.env.BASE_PATH || '';
}

const router = express.Router();

// Servez les assets statiques du scan (css/js/icons) si présents
const scanAssetsDir = path.join(__dirname, '..', 'public', 'scan');
router.use('/scan', express.static(scanAssetsDir)); // ex: /scan/scan.css, /scan/scan.js, /scan/icon-192.png

// ---------- API de scan protégée ----------
function requireScanner(req,res,next) {
  const tok = req.headers.authorization?.replace(/^Bearer\s+/i,'');
  if (!tok || tok !== (process.env.SCANNER_TOKEN||'')) {
    return res.status(401).json({ error:'unauthorized' });
  }
  next();
}

/**
 * POST /api/scan
 * Body: { value: "qr|sig", eventId, deviceId, force?:true }
 * Répond: { ok:true, ticket:{...} } | { ok:false, reason:"..." }
 */
router.post('/api/scan', requireScanner, async (req,res) => {
console.log("hello")
  const now = new Date();
  const { value: raw, eventId, deviceId, force } = req.body || {};
  if (!raw || !eventId) return res.status(400).json({ ok:false, error:'missing_params' });

  // vérif signature si activée
  let value = raw;
  if (process.env.QR_SECRET) {
    const { ok, value: v } = verifySignature(raw);
    if (!ok) {
      await ScanLog.create({ when: now, eventId, qrValue: raw, ok:false, reason: 'bad_sig', deviceId });
      return res.json({ ok:false, reason:'invalid_signature' });
    }
    value = v;
  }

  const t = await Ticket.findOne({ 'qr.value': raw }).lean();
  if (!t) {
    await ScanLog.create({ when: now, eventId, qrValue: raw, ok:false, reason: 'unknown_qr', deviceId });
    return res.json({ ok:false, reason: 'unknown_qr' });
  }
  if (t.eventId !== eventId) {
    await ScanLog.create({ when: now, eventId, ticketId: t._id, qrValue: raw, ok:false, reason:'event_mismatch', deviceId });
    return res.json({ ok:false, reason:'wrong_event' });
  }

  if (t.scannedAt && !force) {
    await ScanLog.create({ when: now, eventId, ticketId: t._id, qrValue: raw, ok:false, reason:'already_scanned', deviceId });
    return res.json({ ok:false, reason:'already_scanned', scannedAt: t.scannedAt, scannedBy: t.scannedBy });
  }

  const updated = await Ticket.findByIdAndUpdate(
    t._id,
    { $set: { scannedAt: now, scannedBy: (req.headers['x-gate'] || process.env.SCAN_GATE_NAME || deviceId) },
      $inc: { scanCount: 1 } },
    { new: true }
  );

  await ScanLog.create({ when: now, eventId, ticketId: t._id, qrValue: raw, ok:true, deviceId, reason: force ? 'forced' : null });

  res.json({
    ok:true,
    ticket: {
      id: String(updated._id),
      seatId: updated.seatId,
      holder: updated.holder,
      tariffCode: updated.tariffCode,
      scannedAt: updated.scannedAt,
      scannedBy: updated.scannedBy
    }
  });
});

// ---------- PWA (view + manifest + service worker) ----------

// GET /scan (view)
router.get('/scan', (req,res) => {
  const bp = basePath();
  // scope côté serveur (utile si tu veux construire des URLs server-side)
  const scope = `${bp}/scan/`.replace('//','/');
  res.render('scan/index', {
    title: 'Contrôle d’accès — BTS',
    basePath: bp,
    scope
  });
});

// GET /bts/scan/manifest.webmanifest
router.get('/scan/manifest.webmanifest', (req,res) => {
  const bp = basePath();
  const scope = `${bp}/scan/`.replace('//','/');
  const manifest = {
    name: 'BTS Contrôle',
    short_name: 'BTS Scan',
    start_url: `${scope}?source=pwa`,
    scope,
    display: 'standalone',
    background_color: '#0b0f17',
    theme_color: '#0b0f17',
    icons: [
      { src: `${scope}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: `${scope}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  };
  res.type('application/manifest+json').send(JSON.stringify(manifest));
});

// GET /bts/scan/sw.js (service worker)
router.get('/scan/sw.js', (req,res) => {
  res.type('text/javascript').send(`
// BTS Scan Service Worker
const VERSION = 'v1.0.1';
self.addEventListener('install', (e)=>{
  e.waitUntil((async()=>{
    const c = await caches.open('bts-scan-shell-'+VERSION);
    // Cache léger: on laisse la page charger ses assets; offline ≈ manifest/JS/CSS via HTTP cache
    await c.addAll([self.registration.scope, self.registration.scope + 'manifest.webmanifest']);
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e)=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=>k.startsWith('bts-scan-shell-') && !k.endsWith(VERSION)).map(k=>caches.delete(k)));
    self.clients.claim();
  })());
});
// Network-first pour éviter de cacher la page active
self.addEventListener('fetch', (event)=>{
  const url = new URL(event.request.url);
  // on ne s'occupe que du scope PWA
  if (!url.href.startsWith(self.registration.scope)) return;
  if (event.request.method !== 'GET') return;
  event.respondWith((async()=>{
    try {
      return await fetch(event.request);
    } catch {
      const cache = await caches.open('bts-scan-shell-'+VERSION);
      const cached = await cache.match(event.request);
      return cached || new Response('Offline', { status: 503 });
    }
  })());
});
// Background sync minimal (optionnel)
self.addEventListener('message', async (event)=>{
  // future hook: flush queue via postMessage si besoin
});
  `);
});

export default router;
