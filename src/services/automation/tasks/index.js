// src/services/automation/tasks/index.js
import { registerTask, hasTask } from '../registry.js';
import { sendRenewInvitesTask } from './send-renew-invites.js';
import { importEventOrdersTask } from './import-event-orders.js';

let registered = false;

export function registerDefaultAutomationTasks({ force = false } = {}) {
  if (registered && !force) return;

  if (!hasTask(sendRenewInvitesTask.id) || force) {
    registerTask(sendRenewInvitesTask);
  }
  if (!hasTask(importEventOrdersTask.id) || force) {
    registerTask(importEventOrdersTask);
  }

  registered = true;
}

export { sendRenewInvitesTask } from './send-renew-invites.js';
export { importEventOrdersTask } from './import-event-orders.js';
