// src/routes/partner.js
import { Router } from 'express';
import createEventFlowRouter from './event-flow.factory.js';
import { getPartnerConfig } from '../config/partners.js';
import { Order } from '../models/Order.js';

const router = Router();
const adminRouter = Router({ mergeParams: true });

function expectedPartnerToken(cfg, eventSlug) {
  if (!cfg) return null;
  if (cfg.tokens?.events && eventSlug && cfg.tokens.events[eventSlug]) {
    return cfg.tokens.events[eventSlug];
  }
  return cfg.accessToken || null;
}

function verifyPartnerToken(req, cfg) {
  const expected = expectedPartnerToken(cfg, req.params.eventId || req.params.eventSlug);
  if (!expected) return true;
  const provided = (req.query?.token || req.get('x-partner-token') || '').trim();
  return provided && provided === expected;
}

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
  if (!verifyPartnerToken(req, cfg)) {
    if (req.accepts('json')) {
      return res.status(403).json({ ok: false, error: 'partner_token_invalid' });
    }
    return res.status(403).send('Access restricted for this partner (token).');
  }
  req.partnerConfig = cfg;
  next();
}, partnerEventRouter);

function requirePartnerAdmin(cfg) {
  return (req, res, next) => {
    const user = cfg?.admin?.user;
    const pass = cfg?.admin?.pass;
    if (!user || !pass) {
      return res.status(403).send('Partner admin disabled.');
    }
    const header = req.get('authorization') || '';
    if (!header.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="Partner Admin"');
      return res.status(401).send('Auth required');
    }
    const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString('utf8');
    const [u, p] = decoded.split(':');
    if (u === user && p === pass) return next();
    res.set('WWW-Authenticate', 'Basic realm="Partner Admin"');
    return res.status(401).send('Auth required');
  };
}

function orderToCsvRow(ord) {
  const lines = Array.isArray(ord.lines) ? ord.lines : [];
  return lines.map((ln, idx) => {
    const meta = ln?.meta || {};
    const partnerPrice = ln.partnerPriceCents ?? meta.partnerPriceCents ?? ln.priceCents;
    const displayPrice = ln.priceCents || 0;
    const delta = partnerPrice - displayPrice;
    return [
      ord._id,
      ord.createdAt ? new Date(ord.createdAt).toISOString() : '',
      ord.eventSlug || ord?.meta?.eventSlug || '',
      ord.eventName || ord?.meta?.eventName || '',
      ln.seatId || '',
      ln.zoneKey || '',
      ln.tariffCode || '',
      displayPrice,
      partnerPrice,
      delta,
      ord.payerEmail || '',
      ord.payerFirstName || '',
      ord.payerLastName || ''
    ].join(',');
  }).join('\n');
}

adminRouter.get('/:partnerSlug/admin', (req, res, next) => {
  const cfg = getPartnerConfig(req.params.partnerSlug);
  if (!cfg) return res.status(404).send('Partner not found');
  req.partnerConfig = cfg;
  next();
}, (req, res) => requirePartnerAdmin(req.partnerConfig)(req, res, async () => {
  try {
    const slug = req.partnerConfig.slug;
    const orders = await Order.find({ 'meta.partner.slug': slug }).lean();
    const format = (req.query.format || '').toLowerCase();
    if (format === 'csv') {
      const header = ['orderId','createdAt','eventSlug','eventName','seatId','zoneKey','tariffCode','displayPriceCents','partnerPriceCents','deltaCents','payerEmail','payerFirstName','payerLastName'].join(',');
      const rows = orders.map(orderToCsvRow).filter(Boolean).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.send([header, rows].filter(Boolean).join('\n'));
      return;
    }
    const summary = orders.reduce((acc, o) => {
      const meta = o?.meta?.partner || {};
      acc.displayTotal += meta.displayTotalCents || 0;
      acc.partnerTotal += meta.partnerTotalCents || 0;
      acc.deltaTotal += meta.deltaCents || 0;
      acc.count += 1;
      return acc;
    }, { displayTotal: 0, partnerTotal: 0, deltaTotal: 0, count: 0 });
    res.json({ ok: true, summary, orders });
  } catch (err) {
    console.error('[partner/admin] error:', err);
    res.status(500).json({ ok: false, error: err.message || 'admin_error' });
  }
}));

export { adminRouter };
export default router;
