// src/routes/event.js
import createEventFlowRouter from './event-flow.factory.js';

export default createEventFlowRouter({
  flowKey: 'event',
  uiPath: '/event',
  itemNamePrefix: 'EVENT',
  groupKeyPrefix: 'EVENT',
  mailTemplateKind: 'event'
});
