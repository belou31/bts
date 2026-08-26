// src/routes/admin/vouchers.routes.js
//
// Actions JSON du panneau admin « Bons cadeaux » (index.js rend la page
// elle-même — voir router.get('/vouchers', …)).
//
// Un bon est un objet physique remis à un tiers : une fois la carte imprimée,
// la seule façon de corriger une erreur est d'agir sur le document. D'où ces
// trois gestes — suspendre, réactiver, prolonger — plutôt qu'une suppression.

import { Router } from 'express';
import mongoose from 'mongoose';

import { Voucher } from '../../models/Voucher.js';
import { signVoucherToken } from '../../services/vouchers.js';
import { adminAuth } from './index.js';

const router = Router();
router.use(adminAuth);

const isId = (id) => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);

async function loadVoucher(req, res) {
  const { id } = req.params;
  if (!isId(id)) { res.status(400).json({ error: 'invalid_id' }); return null; }
  const voucher = await Voucher.findById(id);
  if (!voucher) { res.status(404).json({ error: 'not_found' }); return null; }
  return voucher;
}

// Le lien à réimprimer / renvoyer : reconstruit à la demande, jamais stocké,
// pour qu'il suive toujours APP_URL et le secret courants.
router.get('/:id/link', async (req, res) => {
  const voucher = await loadVoucher(req, res);
  if (!voucher) return undefined;
  try {
    const token = signVoucherToken(voucher.code, { expiresAt: voucher.expiresAt });
    const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
    return res.json({ ok: true, url: `${base}/voucher?id=${token}`, code: voucher.code });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'link_failed' });
  }
});

router.post('/:id/suspend', async (req, res) => {
  const voucher = await loadVoucher(req, res);
  if (!voucher) return undefined;
  if (voucher.status === 'canceled') return res.status(409).json({ error: 'voucher_canceled' });
  voucher.status = 'suspended';
  await voucher.save();
  return res.json({ ok: true, status: voucher.status });
});

router.post('/:id/activate', async (req, res) => {
  const voucher = await loadVoucher(req, res);
  if (!voucher) return undefined;
  if (voucher.status === 'canceled') return res.status(409).json({ error: 'voucher_canceled' });
  // Un bon épuisé ne se « réactive » pas : son solde est à zéro, le remettre
  // actif ne ferait que promettre des places qui n'existent pas.
  const remaining = Number(voucher.balance?.total || 0) - Number(voucher.balance?.used || 0);
  voucher.status = remaining > 0 ? 'active' : 'spent';
  await voucher.save();
  return res.json({ ok: true, status: voucher.status });
});

router.post('/:id/cancel', async (req, res) => {
  const voucher = await loadVoucher(req, res);
  if (!voucher) return undefined;
  voucher.status = 'canceled';
  await voucher.save();
  return res.json({ ok: true, status: voucher.status });
});

// Prolongation : le cas le plus courant en pratique (un bon de fin de saison
// dont le calendrier suivant sort plus tard que prévu).
router.post('/:id/extend', async (req, res) => {
  const voucher = await loadVoucher(req, res);
  if (!voucher) return undefined;
  const raw = String(req.body?.expiresAt || '').trim();
  if (!raw) return res.status(400).json({ error: 'missing_date' });
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'invalid_date' });

  voucher.expiresAt = when;
  // Prolonger un bon expiré doit le remettre en service, sinon le geste
  // n'a aucun effet visible pour le bénéficiaire.
  const remaining = Number(voucher.balance?.total || 0) - Number(voucher.balance?.used || 0);
  if (voucher.status !== 'canceled' && remaining > 0 && when > new Date()) {
    voucher.status = 'active';
  }
  await voucher.save();
  return res.json({ ok: true, expiresAt: voucher.expiresAt, status: voucher.status });
});

export default router;
