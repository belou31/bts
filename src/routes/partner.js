// src/routes/partner.js
import { Router } from 'express';
import createEventFlowRouter from './event-flow.factory.js';
import { getPartnerConfig } from '../config/partners.js';

const router = Router();

const partnerEventRouter = createEventFlowRouter({
  flowKey: 'partner',
  uiPath: '/partner',
  itemNamePrefix: 'PARTNER_EVENT',
  groupKeyPrefix: 'PARTNER',
  mailTemplateKind: 'event',
  originExtras: { channel: 'partner' },
  channelResolver: (req) => ({
    kind: 'partner',
    partnerSlug: String(req.params.partnerSlug || '').trim().toLowerCase(),
    partnerConfig: req.partnerConfig || null
  }),
  originResolver: (req, origin) => ({
    ...origin,
    partnerSlug: String(req.params.partnerSlug || '').trim()
  }),
  invoiceReservations: (req) => {
    const cfg = req.partnerConfig;
    if (!cfg || cfg.paymentMode === 'psp') return null;
    return {
      enabled: true,
      status: cfg.reserve?.status || 'pending_invoice',
      paymentProvider: cfg.reserve?.paymentProvider || 'partner_invoice',
      paymentProviderMeta: { partnerSlug: cfg.slug },
      mailTemplateKind: cfg.reserve?.mailTemplateKind || 'event',
      autoFinalize: cfg.reserve?.autoFinalize === true,
      sendTickets: cfg.reserve?.sendTickets !== false
    };
  }
});

router.use('/:partnerSlug/event', (req, res, next) => {
  const cfg = getPartnerConfig(req.params.partnerSlug);
  if (!cfg) {
    if (req.accepts('json')) {
      return res.status(404).json({ ok: false, error: 'partner_not_found' });
    }
    return res.status(404).send('Partner not found');
  }
  req.partnerConfig = cfg;
  next();
}, partnerEventRouter);

export default router;
