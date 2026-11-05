// src/services/automation/tasks/export-zone-tariffs.js
import { TariffPrice } from '../../../models/TariffPrice.js';

function euro(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

export const exportZoneTariffsTask = {
  id: 'tariff.export-zone-tariffs',
  version: '1.0.0',
  summary: 'Exporte les prix par zone ou méta-zone (zoneKey/metaZone/tariffCode/prix) pour une saison et un lieu donnés.',
  chapter: '02 — Tariff Management',
  tags: ['tariff', 'zone', 'prices'],
  scopes: ['automation:jobs:write', 'automation:jobs:run'],
  schema: {
    type: 'object',
    required: ['seasonCode', 'venueSlug'],
    properties: {
      seasonCode: { type: 'string' },
      venueSlug: { type: 'string' }
    }
  },
  async validateParams(params = {}) {
    if (!params.seasonCode || !params.venueSlug) {
      throw new Error('Fournissez seasonCode et venueSlug.');
    }
  },
  async handler(params = {}) {
    const seasonCode = String(params.seasonCode);
    const venueSlug = String(params.venueSlug);

    const docs = await TariffPrice.find({ seasonCode, venueSlug }).lean();
    // Cible effective : une ligne par méta-zone n'a pas de zoneKey.
    const target = (d) => d.zoneKey || d.metaZone || '';
    docs.sort((a, b) => target(a).localeCompare(target(b)) || (a.tariffCode || '').localeCompare(b.tariffCode || ''));

    const entries = docs.map((d) => {
      const partnerCents = Number(d.partnerPriceCents);
      return {
        zoneKey: d.zoneKey || '',
        metaZone: d.metaZone || '',
        tariffCode: d.tariffCode,
        priceCents: d.priceCents,
        priceEuro: euro(d.priceCents),
        partnerPriceCents: Number.isFinite(partnerCents) ? partnerCents : '',
        partnerPriceEuro: Number.isFinite(partnerCents) ? euro(partnerCents) : '',
        currency: d.currency || 'EUR'
      };
    });

    return {
      summary: `exported=${entries.length}`,
      payload: { seasonCode, venueSlug, entries }
    };
  }
};

export default exportZoneTariffsTask;
