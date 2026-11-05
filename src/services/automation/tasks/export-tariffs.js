// src/services/automation/tasks/export-tariffs.js
import { Tariff } from '../../../models/Tariff.js';

export const exportTariffsTask = {
  id: 'tariff.export-catalog',
  version: '1.0.0',
  summary: 'Exporte le catalogue de tarifs (code/label/...) au format JSON.',
  chapter: '02 — Tariff Management',
  tags: ['tariff', 'catalog'],
  scopes: ['automation:jobs:write', 'automation:jobs:run'],
  async handler() {
    const docs = await Tariff.find({}).sort({ sortOrder: 1, label: 1 }).lean();

    const entries = docs.map((d) => ({
      code: d.code,
      label: d.label || '',
      requiresField: d.requiresField || '',
      fieldLabel: d.fieldLabel || '',
      requiresInfo: d.requiresInfo || '',
      active: Boolean(d.active),
      sortOrder: Number.isFinite(d.sortOrder) ? d.sortOrder : 100,
      channels: Array.isArray(d.channels) ? d.channels.join(',') : ''
    }));

    return {
      summary: `exported=${entries.length}`,
      payload: { entries }
    };
  }
};

export default exportTariffsTask;
