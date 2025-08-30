// src/routes/public.js
import express from 'express';

const router = express.Router();

/**
 * GET /  → redirige vers /s/renew (basePath géré par loaders/express)
 */
router.get('/', (req, res) => {
  const base = (process.env.APP_URL || '').replace(/^https?:\/\/[^/]+/, '');
  const target = base ? `${base}/s/renew` : '/s/renew';
  res.redirect(target);
});

export default router;
