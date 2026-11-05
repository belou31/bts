// src/routes/promo.js
// Redirect target for personalized/trackable promo QR codes printed on
// tickets (see buildTicketsPdfBuffer in src/services/tickets-pdf.js — one
// signed token per ticket+campaign). Looks up the campaign's CURRENT
// targetUrl at click time (not baked into the QR), so a sponsor's link can
// change after tickets are already printed — and since targetUrl lives on
// the global AdCampaign master (not scoped per event), the lookup is a
// simple slug, no priceTableKey involved.
import express from 'express';
import { AdCampaign } from '../models/AdCampaign.js';
import { AdClick } from '../models/AdClick.js';
import { verifySignature } from '../services/qr.js';

const router = express.Router();

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

router.get('/:token', async (req, res) => {
  const { ok, value } = verifySignature(String(req.params.token || ''));
  if (!ok) return res.status(404).send('Not found');

  const [slug, ticketId, orderId] = String(value).split('|');
  if (!slug) return res.status(404).send('Not found');

  const campaign = await AdCampaign.findOne({ slug, active: true }).lean();
  if (!campaign?.targetUrl) return res.status(404).send('Not found');

  AdClick.create({
    campaignSlug: slug,
    ticketId: OBJECT_ID_RE.test(ticketId) ? ticketId : null,
    orderId: OBJECT_ID_RE.test(orderId) ? orderId : null,
    token: req.params.token,
    targetUrl: campaign.targetUrl,
    ip: req.ip,
    userAgent: req.headers['user-agent'] || null
  }).catch((e) => console.warn('[promo] AdClick log failed:', e.message || e));

  res.redirect(302, campaign.targetUrl);
});

export default router;
