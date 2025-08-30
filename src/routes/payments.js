// src/routes/payments.js
import express from 'express';
import { splitInstallmentAmounts } from '../utils/money.js';

const router = express.Router();

/**
 * GET /api/payments/health
 */
router.get('/api/payments/health', (_req, res) => {
  res.json({ ok: true, provider: 'helloasso' });
});

/**
 * POST /api/payments/split
 * Body: { totalCents: number, count: 1|2|3 }
 * → { terms: number[] }
 */
router.post('/api/payments/split', (req, res) => {
  const totalCents = Number(req.body?.totalCents || 0);
  const count = Number(req.body?.count || 1);
  try {
    const terms = splitInstallmentAmounts(totalCents, count);
    res.json({ terms, totalCents });
  } catch (e) {
    res.status(400).json({ error: e.message || 'invalid split' });
  }
});

/**
 * Exemple générique de payload HelloAsso (si tu veux construire côté front)
 * POST /api/payments/checkout-payload
 * Body: { totalCents: number, terms?: number[] }
 */
router.post('/api/payments/checkout-payload', (req, res) => {
  const totalCents = Number(req.body?.totalCents || 0);
  const terms = Array.isArray(req.body?.terms) ? req.body.terms.map(Number) : [];
  const payload = {
    totalAmount: totalCents,
    // ✅ correction du bug :
    ...(terms.length ? { terms } : {})
  };
  res.json(payload);
});

export default router;
