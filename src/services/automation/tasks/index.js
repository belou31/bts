// src/services/automation/tasks/index.js
import { registerTask, hasTask } from '../registry.js';
import { sendRenewInvitesTask } from './send-renew-invites.js';
import { importEventOrdersTask } from './import-event-orders.js';
import { importTariffsTask } from './import-tariffs.js';
import { importTariffPricesTask } from './import-tariff-prices.js';
import { exportTariffsTask } from './export-tariffs.js';
import { exportZoneTariffsTask } from './export-zone-tariffs.js';

let registered = false;

export function registerDefaultAutomationTasks({ force = false } = {}) {
  if (registered && !force) return;

  if (!hasTask(sendRenewInvitesTask.id) || force) {
    registerTask(sendRenewInvitesTask);
  }
  if (!hasTask(importEventOrdersTask.id) || force) {
    registerTask(importEventOrdersTask);
  }
  if (!hasTask(importTariffsTask.id) || force) {
    registerTask(importTariffsTask);
  }
  if (!hasTask(importTariffPricesTask.id) || force) {
    registerTask(importTariffPricesTask);
  }
  if (!hasTask(exportTariffsTask.id) || force) {
    registerTask(exportTariffsTask);
  }
  if (!hasTask(exportZoneTariffsTask.id) || force) {
    registerTask(exportZoneTariffsTask);
  }

  registered = true;
}

export { sendRenewInvitesTask } from './send-renew-invites.js';
export { importEventOrdersTask } from './import-event-orders.js';
export { importTariffsTask } from './import-tariffs.js';
export { importTariffPricesTask } from './import-tariff-prices.js';
export { exportTariffsTask } from './export-tariffs.js';
export { exportZoneTariffsTask } from './export-zone-tariffs.js';
