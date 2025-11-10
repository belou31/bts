import { Tariff } from '../../models/Tariff.js';
import { TariffPriceCatalog } from '../../models/TariffPriceCatalog.js';
import { serializeChannelList } from '../../utils/channel-scopes.js';

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const str = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(str)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(str)) return false;
  return fallback;
}

function normalizeSortOrder(value, fallback = 100) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeUpper(value) {
  return normalizeString(value).toUpperCase();
}

function parsePriceInput(entry) {
  if (entry.priceCents !== undefined && entry.priceCents !== null && entry.priceCents !== '') {
    const cents = Number(entry.priceCents);
    if (Number.isFinite(cents)) return Math.round(cents);
  }
  if (entry.priceEuro !== undefined && entry.priceEuro !== null && entry.priceEuro !== '') {
    const normalized = String(entry.priceEuro).trim().replace(/\s/g, '').replace(',', '.');
    const euros = Number(normalized);
    if (Number.isFinite(euros)) return Math.round(euros * 100);
  }
  if (entry.price !== undefined && entry.price !== null && entry.price !== '') {
    const normalized = String(entry.price).trim().replace(/\s/g, '').replace(',', '.');
    const euros = Number(normalized);
    if (Number.isFinite(euros)) {
      if (Math.abs(euros) >= 1000 && Number.isInteger(euros)) {
        return Math.round(euros);
      }
      return Math.round(euros * 100);
    }
  }
  return null;
}

export async function importTariffCatalog({
  entries = [],
  dryRun = false,
  logger
} = {}) {
  const summary = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: []
  };

  if (!Array.isArray(entries) || !entries.length) {
    throw new Error('Aucune entrée fournie (entries).');
  }

  for (const rawEntry of entries) {
    const code = normalizeUpper(rawEntry.code);
    const label = normalizeString(rawEntry.label);
    if (!code || !label) {
      summary.skipped += 1;
      summary.errors.push(`Entrée invalide (code/label manquant): ${JSON.stringify(rawEntry)}`);
      continue;
    }

    const requiresField = normalizeString(rawEntry.requiresField || rawEntry.requires_field || '');
    const fieldLabel = normalizeString(rawEntry.fieldLabel || rawEntry.field_label || '');
    const requiresInfo = normalizeString(rawEntry.requiresInfo || rawEntry.requires_info || '');
    const active = normalizeBoolean(
      rawEntry.active ?? rawEntry.isActive ?? rawEntry.enabled,
      true
    );
    const sortOrder = normalizeSortOrder(rawEntry.sortOrder ?? rawEntry.sort_order);
    const channels = serializeChannelList(
      rawEntry.channels ?? rawEntry.channel ?? rawEntry.scopes ?? rawEntry.channelScopes
    );

    if (dryRun) {
      const exists = await Tariff.exists({ code });
      if (exists) summary.updated += 1;
      else summary.created += 1;
      continue;
    }

    const existing = await Tariff.findOne({ code });
    if (existing) {
      existing.label = label;
      existing.requiresField = requiresField || null;
      existing.fieldLabel = fieldLabel || null;
      existing.requiresInfo = requiresInfo || null;
      existing.active = active;
      existing.sortOrder = sortOrder;
      existing.channels = channels;
      await existing.save();
      summary.updated += 1;
      continue;
    }

    await Tariff.create({
      code,
      label,
      requiresField: requiresField || null,
      fieldLabel: fieldLabel || null,
      requiresInfo: requiresInfo || null,
      active,
      sortOrder,
      channels
    });
    summary.created += 1;
  }

  logger?.info?.('[importTariffCatalog] done', summary);
  return summary;
}

export async function importTariffPriceCatalog({
  entries = [],
  catalogSlug,
  venueSlug = null,
  append = false,
  dryRun = false,
  logger
} = {}) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error('Aucune entrée fournie (entries)');
  }

  const normalizedEntries = [];
  const errors = [];

  entries.forEach((rawEntry) => {
    const slug = normalizeString(rawEntry.catalogSlug || catalogSlug || '');
    const venue = normalizeString(rawEntry.venueSlug ?? venueSlug ?? '');
    const zoneKey = normalizeUpper(rawEntry.zoneKey || rawEntry.zone || '');
    const tariffCode = normalizeUpper(rawEntry.tariffCode || rawEntry.tariff || rawEntry.code || '');
    const priceCents = parsePriceInput(rawEntry);

    if (!slug || !zoneKey || !tariffCode || priceCents === null) {
      errors.push(`Ligne invalide (slug/zone/tarif/prix): ${JSON.stringify(rawEntry)}`);
      return;
    }

    normalizedEntries.push({
      catalogSlug: slug,
      venueSlug: venue || null,
      zoneKey,
      tariffCode,
      priceCents,
      currency: normalizeString(rawEntry.currency || 'EUR') || 'EUR',
      channels: serializeChannelList(
        rawEntry.channels ?? rawEntry.channel ?? rawEntry.scopes ?? rawEntry.channelScopes
      )
    });
  });

  if (!normalizedEntries.length) {
    throw new Error(
      errors.length ? errors.join('\n') : 'Aucune entrée valide après normalisation.'
    );
  }

  const summary = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: errors.length,
    errors
  };

  if (dryRun) {
    const uniquePairs = new Set(
      normalizedEntries.map(
        (entry) => `${entry.catalogSlug}::${entry.venueSlug || 'null'}::${entry.zoneKey}::${entry.tariffCode}`
      )
    );
    summary.inserted = uniquePairs.size;
    logger?.info?.('[importTariffPriceCatalog] dry-run result', summary);
    return summary;
  }

  if (!append) {
    const combos = new Map();
    normalizedEntries.forEach((entry) => {
      const key = `${entry.catalogSlug}::${entry.venueSlug || 'null'}`;
      combos.set(key, entry);
    });
    for (const entry of combos.values()) {
      const filter = {
        catalogSlug: entry.catalogSlug,
        venueSlug: entry.venueSlug || null
      };
      await TariffPriceCatalog.deleteMany(filter);
      logger?.info?.('[importTariffPriceCatalog] cleared catalog', filter);
    }
  }

  for (const entry of normalizedEntries) {
    const filter = {
      catalogSlug: entry.catalogSlug,
      venueSlug: entry.venueSlug || null,
      zoneKey: entry.zoneKey,
      tariffCode: entry.tariffCode
    };
    const update = {
      $set: {
        priceCents: entry.priceCents,
        currency: entry.currency,
        channels: entry.channels
      }
    };
    const result = await TariffPriceCatalog.updateOne(filter, update, { upsert: true });
    if (result.upsertedCount && result.upsertedCount > 0) {
      summary.inserted += 1;
    } else if (result.modifiedCount && result.modifiedCount > 0) {
      summary.updated += 1;
    } else {
      summary.unchanged += 1;
    }
  }

  logger?.info?.('[importTariffPriceCatalog] done', summary);
  return summary;
}
