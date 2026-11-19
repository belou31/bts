// src/services/automation/tasks/import-tariffs.js
import { importTariffCatalog } from '../../importers/tariffImporters.js';

export const importTariffsTask = {
  id: 'tariff.import-catalog',
  version: '1.0.0',
  summary: 'Importe le catalogue de tarifs (code/label...) depuis un tableur ou JSON.',
  chapter: '02 — Tariff Management',
  tags: ['tariff', 'catalog'],
  scopes: ['automation:jobs:write', 'automation:jobs:run'],
  allowDryRun: true,
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      entries: {
        type: 'array',
        description: 'Entrées du catalogue de tarifs',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            label: { type: 'string' },
            requiresField: { type: 'string' },
            fieldLabel: { type: 'string' },
            requiresInfo: { type: 'string' },
            active: { type: ['boolean', 'string', 'number'] },
            sortOrder: { type: ['number', 'string'] },
            channels: { type: ['string', 'array'], items: { type: 'string' } }
          }
        }
      }
    }
  },
  async validateParams(params = {}) {
    if (!Array.isArray(params.entries) || params.entries.length === 0) {
      throw new Error('Ajoutez le tableau "entries" (code, label, etc.).');
    }
  },
  async handler(params = {}, context) {
    const logger = context?.logger;
    const dryRun = Boolean(context?.dryRun);

    const summary = await importTariffCatalog({
      entries: Array.isArray(params.entries) ? params.entries : [],
      dryRun,
      logger
    });

    return {
      summary: `created=${summary.created} updated=${summary.updated} skipped=${summary.skipped}`,
      payload: summary
    };
  }
};

export default importTariffsTask;
