// src/routes/admin-email.js
import express from  'express';
import { celebrate, Joi, Segments } from 'celebrate';

import { requireAdmin } from '../middlewares/authz.js';
import { sendMail } from '../services/mailer.js';

import dotenv from 'dotenv';
dotenv.config();

const router = express.Router();

router.get(
  '/api/admin/email/test',
  requireAdmin,
  celebrate({ [Segments.QUERY]: Joi.object({ to: Joi.string().email().required() }) }),
  async (req, res, next) => {
    try {
      const to = req.query.to;
      const env = process.env.APP_ENV || 'development';
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif">
          <h3>Test e-mail BTS</h3>
          <p>Environnement: <b>${env}</b></p>
          <p>Heure serveur: ${new Date().toISOString()}</p>
        </div>`;
      const r = await sendMail({ to, subject: `BTS · Test e-mail (${env})`, html });
      res.json({ ok: true, result: r });
    } catch (e) { next(e); }
  }
);

export default router;
