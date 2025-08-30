// src/routes/admin-tariff-catalog.js
import express from 'express';
import { Tariff } from '../models/index.js';
// (optionnel) import { requireAdmin } from '../middlewares/authz.js';

const router = express.Router();

/**
 * GET /admin/tariffs
 */
router.get('/admin/tariffs', async (_req, res, next) => {
  try {
    const rows = await Tariff.find({}).sort({ sortOrder: 1, code: 1 }).lean();
    res.json({ tariffs: rows });
  } catch (e) { next(e); }
});

/**
 * POST /admin/tariffs (upsert unitaire)
 * Body: { code, label, active?, sortOrder?, requiresField?, fieldLabel?, requiresInfo? }
 */
router.post('/admin/tariffs', async (req, res, next) => {
  try {
    const t = req.body || {};
    if (!t.code) return res.status(400).json({ error: 'code requis' });
    const doc = {
      code: String(t.code).toUpperCase(),
      label: t.label || t.code,
      active: t.active !== false,
      sortOrder: Number.isFinite(t.sortOrder) ? Number(t.sortOrder) : 100,
      requiresField: t.requiresField || null,
      fieldLabel: t.fieldLabel || null,
      requiresInfo: t.requiresInfo || null
    };
    await Tariff.updateOne({ code: doc.code }, { $set: doc }, { upsert: true });
    const updated = await Tariff.findOne({ code: doc.code }).lean();
    res.json({ tariff: updated });
  } catch (e) { next(e); }
});

/**
 * DELETE /admin/tariffs/:code
 */
router.delete('/admin/tariffs/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    if (!code) return res.status(400).json({ error: 'code requis' });
    const r = await Tariff.deleteOne({ code });
    res.json({ deleted: r.deletedCount === 1 });
  } catch (e) { next(e); }
});

export default router;
