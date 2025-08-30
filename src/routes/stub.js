// src/routes/stub.js
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

const router = express.Router();

function isStubEnabled() {
  const env = (process.env.APP_ENV || 'development').toLowerCase();
  return process.env.HELLOASSO_STUB === 'true' || env === 'development';
}

// Intercepteur STUB pour HelloAsso
router.post('/api/payments/helloasso/checkout', (req, res, next) => {
  if (!isStubEnabled()) return next(); // passe à la vraie route si non stub

  const result = (process.env.HELLOASSO_STUB_RESULT || 'success').toLowerCase();
  const ok = result === 'success' || result === 'ok' || result === 'true' || result === '1';

  const appUrl = (process.env.APP_URL || 'http://localhost:8080').replace(/\/$/,'');
  const checkoutIntentId = Date.now(); // fake
  const redirectUrl = `${appUrl}/stub/helloasso?result=${ok ? 'success' : 'failure'}&intent=${checkoutIntentId}`;

  return res.json({ redirectUrl, checkoutIntentId });
});

// Petite page d’atterrissage
router.get('/stub/helloasso', (req, res) => {
  const ok = String(req.query.result || 'success') === 'success';
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Stub HelloAsso</title>
<style>body{font-family:system-ui;margin:40px;}</style></head>
<body>
  <h1>Transaction simulée ${ok ? '✅ SUCCÈS' : '❌ ÉCHEC'}</h1>
  <p>checkoutIntentId: <code>${req.query.intent || ''}</code></p>
  <p>Ce mode est un <strong>stub</strong> DEV : aucun appel HelloAsso n’a été réalisé.</p>
  <p><a href="javascript:history.back()">⟵ Revenir</a></p>
</body></html>`;
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(html);
});

export default router;
