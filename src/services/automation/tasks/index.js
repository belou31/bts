// src/services/automation/tasks/index.js
import { registerTask, hasTask } from '../registry.js';
import { sendRenewInvitesTask } from './send-renew-invites.js';

let registered = false;

export function registerDefaultAutomationTasks({ force = false } = {}) {
  if (registered && !force) return;

  if (!hasTask(sendRenewInvitesTask.id) || force) {
    registerTask(sendRenewInvitesTask);
  }

  registered = true;
}

export { sendRenewInvitesTask } from './send-renew-invites.js';

