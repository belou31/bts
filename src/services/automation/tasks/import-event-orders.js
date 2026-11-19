// src/services/automation/tasks/import-event-orders.js
import importEventOrders from '../../importers/eventOrdersImporter.js';

const TASK_ID = 'event.import-orders';

export const importEventOrdersTask = {
  id: TASK_ID,
  version: '1.0.0',
  summary:
    "Importe des commandes d'évènement depuis un CSV (data/inputs) ou un payload JSON et les insère dans MongoDB.",
  chapter: '04 — Event Management',
  tags: ['event', 'orders', 'import'],
  scopes: ['automation:jobs:write', 'automation:jobs:run', 'automation:events:write'],
  allowDryRun: true,
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      csv: {
        type: 'string',
        description: 'Chemin du CSV (relatif à data/inputs ou absolu).'
      },
      orders: {
        type: 'array',
        description: 'Liste d’ordres inline à importer (alternative au CSV).',
        items: {
          type: 'object',
          properties: {
            orderId: { type: 'string' },
            groupKey: { type: 'string' },
            eventId: { type: 'string' },
            eventSlug: { type: 'string' },
            payerEmail: { type: 'string' },
            payerFirstName: { type: 'string' },
            payerLastName: { type: 'string' },
            seasonCode: { type: 'string' },
            venueSlug: { type: 'string' },
            status: { type: 'string' },
            totalCents: { type: 'integer' },
            paymentSplit: { type: 'integer' },
            createdAt: { type: 'string' },
            providerName: { type: 'string' },
            lines: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  seatId: { type: 'string' },
                  zoneKey: { type: 'string' },
                  tariffCode: { type: 'string' },
                  priceCents: { type: 'integer' },
                  quantity: { type: 'integer' },
                  holderFirstName: { type: 'string' },
                  holderLastName: { type: 'string' }
                }
              }
            }
          }
        }
      },
      force: { type: 'boolean' },
      sendEmail: { type: 'boolean' },
      status: { type: 'string' },
      event: { type: 'string' },
      eventId: { type: 'string' },
      eventSlug: { type: 'string' }
    }
  },
  async validateParams(params = {}) {
    const hasCsv = params.csv && typeof params.csv === 'string';
    const hasInline = Array.isArray(params.orders) && params.orders.length > 0;
    if (!hasCsv && !hasInline) {
      throw new Error('Fournissez un chemin CSV (`csv`) ou des ordres inline (`orders`).');
    }
  },
  async handler(params = {}, context) {
    const logger = context?.logger;
    const dryRun = Boolean(context?.dryRun);

    const summary = await importEventOrders({
      csvPath: params.csv,
      inlineOrders: Array.isArray(params.orders) ? params.orders : [],
      dryRun,
      force: Boolean(params.force),
      sendEmail: Boolean(params.sendEmail),
      statusOverride: params.status ? String(params.status).trim().toLowerCase() : null,
      eventOverride:
        params.event || params.eventId || params.eventSlug || null,
      paths: {
        rootDir: context?.paths?.root,
        inputsDir: context?.paths?.inputs
      },
      logger
    });

    logger?.info?.('[automation] import-orders summary', {
      created: summary.created,
      updated: summary.updated,
      skipped: summary.skipped,
      dryRun
    });

    const summaryText = `created=${summary.created} updated=${summary.updated} skipped=${summary.skipped} dryRun=${dryRun ? 'yes' : 'no'}`;

    return {
      summary: summaryText,
      payload: {
        stats: {
          created: summary.created,
          updated: summary.updated,
          skipped: summary.skipped,
          dryRun
        },
        results: summary.results
      }
    };
  }
};

export default importEventOrdersTask;
