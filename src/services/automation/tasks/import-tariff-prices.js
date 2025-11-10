// src/services/automation/tasks/import-tariff-prices.js
import { importTariffPriceCatalog } from '../../importers/tariffImporters.js';

export const importTariffPricesTask = {
  id: 'tariff.import-prices',
  version: '1.0.0',
  summary: 'Importe un catalogue de prix (zone / tarif / prix).',
  tags: ['tariff', 'catalog'],
  scopes: ['automation:jobs:write', 'automation:jobs:run', 'automation:events:write'],
  allowDryRun: true,
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      catalogSlug: { type: 'string' },
      venueSlug: { type: ['string', 'null'] },
      append: { type: 'boolean' },
      entries: {
        type: 'array',
        description: 'Lignes de prix (zone/tarif/prix).',
        items: {
          type: 'object',
          properties: {
            catalogSlug: { type: 'string' },
            venueSlug: { type: ['string', 'null'] },
            zoneKey: { type: 'string' },
            tariffCode: { type: 'string' },
            priceCents: { type: ['number', 'string'] },
            priceEuro: { type: ['number', 'string'] },
            price: { type: ['number', 'string'] },
            currency: { type: 'string' },
            channels: { type: ['string', 'array'], items: { type: 'string' } }
          }
        }
      }
    }
  },
  async validateParams(params = {}) {
    if (!Array.isArray(params.entries) || params.entries.length === 0) {
      throw new Error('Ajoutez le tableau "entries" (catalogSlug, zoneKey, tariffCode, prix...).');
    }
  },
  async handler(params = {}, context) {
    const logger = context?.logger;
    const dryRun = Boolean(context?.dryRun);

    const summary = await importTariffPriceCatalog({
      entries: Array.isArray(params.entries) ? params.entries : [],
      catalogSlug: params.catalogSlug,
      venueSlug: params.venueSlug ?? null,
      append: Boolean(params.append),
      dryRun,
      logger
    });

    return {
      summary: `inserted=${summary.inserted} updated=${summary.updated} unchanged=${summary.unchanged} errors=${summary.errors.length}`,
      payload: summary
    };
  }
};

export default importTariffPricesTask;
