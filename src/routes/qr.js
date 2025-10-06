// src/routes/qr.js
import express from 'express';
import { QrBankCode } from '../models/QrBankCode.js';
import { Ticket }     from '../models/Ticket.js';
import { makeOpaqueCode, signCode, renderQrSvg } from '../services/qr.js';

const router = express.Router();

// Middleware admin basique (reutilise ton modèle /admin)
function requireAdmin(req,res,next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i,'') || req.query.admin_token;
  const ok = token && process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/**
 * Génère une banque de codes opaques (legacy).
 * POST /api/qr/bank/generate  { count:1000, tagged:'VIP' }
 */
router.post('/bank/generate', requireAdmin, async (req,res) => {
  const count = Math.max(1, Math.min(100000, Number(req.body.count||0)));
  const tag   = String(req.body.tag||'');
  if (!count) return res.status(400).json({ error: 'invalid_count' });

  const docs = [];
  for (let i=0;i<count;i++) {
    const raw = makeOpaqueCode({ kind: process.env.QR_CODE_FORMAT || 'hex' });
    const val = process.env.QR_SECRET ? signCode(raw) : raw;
    docs.push({ value: val, tag });
  }
  await QrBankCode.insertMany(docs, { ordered: false });
  res.json({ ok:true, inserted:docs.length });
});

/**
 * Associe (ou régénère) un QR pour un ticket
 * POST /api/tickets/:ticketId/qr { regen?:true }
 */
router.post('/tickets/:ticketId/qr', requireAdmin, async (req,res) => {
  const t = await Ticket.findById(req.params.ticketId);
  if (!t) return res.status(404).json({ error: 'ticket_not_found' });

  // si banker mode et pas déjà affecté : pioche
  let value;
  if (process.env.QR_BANK_MODE === 'true') {
    const doc = await QrBankCode.findOneAndUpdate({ used:false }, { used:true, usedAt:new Date(), ticketId:t._id }, { sort:{_id:1}, new:true });
    if (!doc) return res.status(409).json({ error: 'bank_empty' });
    value = doc.value;
    t.qr = { value, kind: (process.env.QR_CODE_FORMAT||'hex'), createdAt: new Date(), bankId: doc._id };
  } else {
    const raw = makeOpaqueCode({ kind: process.env.QR_CODE_FORMAT || 'hex' });
    value = process.env.QR_SECRET ? signCode(raw) : raw;
    t.qr = { value, kind: (process.env.QR_CODE_FORMAT||'hex'), createdAt: new Date() };
  }
  await t.save();
  res.json({ ok:true, ticketId:String(t._id), qr: t.qr });
});

/**
 * Sert l'image SVG du QR du ticket
 * GET /api/tickets/:ticketId/qr.svg
 */
router.get('/tickets/:ticketId/qr.svg', async (req,res) => {
  const t = await Ticket.findById(req.params.ticketId);
  if (!t?.qr?.value) return res.status(404).send('No QR');
  const svg = await renderQrSvg({ text: t.qr.value, size: Number(req.query.size||256) });
  res.setHeader('Content-Type','image/svg+xml; charset=utf-8');
  res.send(svg);
});

export default router;
