// src/routes/partner.js
import { Router } from 'express';
import createEventFlowRouter from './event-flow.factory.js';

const router = Router();

const eventFlowRouter = createEventFlowRouter({
  flowKey: 'partner',
  uiPath: '/partner',
  itemNamePrefix: 'PARTNER_EVENT',
  groupKeyPrefix: 'PARTNER',
  mailTemplateKind: 'event',
  originExtras: { channel: 'partner' }
});

router.use('/:partnerSlug/event', eventFlowRouter);

export default router;
