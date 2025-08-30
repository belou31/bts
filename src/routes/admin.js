// src/routes/admin.js
import express from 'express';

import { requireAdmin } from '../middlewares/authz.js';
import { Season } from '../models/Season.js';
import { Seat } from '../models/Seat.js';

const router = express.Router();

// (optionnel) ping admin
router.get('/health', requireAdmin, (_req, res) => {
  res.json({ ok: true, scope: 'admin' });
});

/**
 * Ferme la phase "renewal" pour la saison active.
 * Réponse: { ok, seasonCode, phase }
 */
router.post('/renewal/close', requireAdmin, async (_req, res, next) => {
  try {
    const season = await Season.findOne({ active: true });
    if (!season) return res.status(404).json({ error: 'no active season' });

    if (!Array.isArray(season.phases)) season.phases = [];
    const idx = season.phases.findIndex(p => p && p.name === 'renewal');
    if (idx === -1) return res.status(404).json({ error: 'renewal phase not found' });

    season.phases[idx].enabled = false;
    season.markModified('phases');
    await season.save();

    res.json({ ok: true, seasonCode: season.code, phase: season.phases[idx] });
  } catch (e) { next(e); }
});

/**
 * Libère toutes les places "provisioned" -> "available" pour la saison active.
 * Réponse: { ok, seasonCode, released }
 */
router.post('/renewal/release-provisioned', requireAdmin, async (_req, res, next) => {
  try {
    const season = await Season.findOne({ active: true });
    if (!season) return res.status(404).json({ error: 'no active season' });

    const r = await Seat.updateMany(
      { seasonCode: season.code, status: 'provisioned' },
      { $set: { status: 'available', provisionedFor: null } }
    );

    res.json({ ok: true, seasonCode: season.code, released: r.modifiedCount });
  } catch (e) { next(e); }
});

export default router;
