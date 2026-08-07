import { AdCampaignCatalog } from '../../models/AdCampaignCatalog.js';

function normalizeString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeUpper(value) {
  return normalizeString(value).toUpperCase();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const str = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(str)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(str)) return false;
  return fallback;
}

function normalizeNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDate(value) {
  const s = normalizeString(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Accepts camelCase, snake_case, or the all-lowercase-no-separator form
// produced by a generic "lowercase every CSV header" parser (this repo's own
// convention — see import-tariffs.js's requiresfield/fieldlabel).
function pick(rawEntry, camel, snake, flat) {
  return rawEntry[camel] ?? rawEntry[snake] ?? rawEntry[flat];
}

export async function importAdCampaignCatalog({
  entries = [],
  catalogSlug,
  venueSlug = null,
  append = false,
  dryRun = false,
  logger
} = {}) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error('Aucune entrée fournie (entries).');
  }

  const slug = normalizeLower(catalogSlug);
  if (!slug) throw new Error('catalogSlug manquant.');
  const venue = normalizeString(venueSlug) || null;

  const normalizedEntries = [];
  const errors = [];

  entries.forEach((rawEntry, idx) => {
    const campaignSlug = normalizeLower(pick(rawEntry, 'campaignSlug', 'campaign_slug', 'campaignslug'));
    const slot = normalizeString(rawEntry.slot);
    const contentType = normalizeLower(pick(rawEntry, 'contentType', 'content_type', 'contenttype'));

    if (!campaignSlug || !slot || !['image', 'qr', 'text'].includes(contentType)) {
      errors.push(`Ligne ${idx + 1} invalide (campaignSlug/slot/contentType manquant ou incorrect): ${JSON.stringify(rawEntry)}`);
      return;
    }

    const zoneTypeRaw = normalizeLower(pick(rawEntry, 'zoneType', 'zone_type', 'zonetype'));
    const zoneType = ['seated', 'standing', 'fanclub'].includes(zoneTypeRaw) ? zoneTypeRaw : null;

    normalizedEntries.push({
      campaignSlug,
      contentType,
      slot,
      qrValue: normalizeString(pick(rawEntry, 'qrValue', 'qr_value', 'qrvalue')) || null,
      text: normalizeString(rawEntry.text) || null,
      tariffCode: normalizeUpper(pick(rawEntry, 'tariffCode', 'tariff_code', 'tariffcode')) || null,
      zoneKey: normalizeUpper(pick(rawEntry, 'zoneKey', 'zone_key', 'zonekey')) || null,
      zoneType,
      priority: normalizeNumber(rawEntry.priority, 100),
      startsAt: normalizeDate(pick(rawEntry, 'startsAt', 'starts_at', 'startsat')),
      endsAt: normalizeDate(pick(rawEntry, 'endsAt', 'ends_at', 'endsat')),
      active: normalizeBoolean(rawEntry.active, true)
    });
  });

  if (!normalizedEntries.length) {
    throw new Error(errors.length ? errors.join('\n') : 'Aucune entrée valide après normalisation.');
  }

  const summary = { inserted: 0, updated: 0, unchanged: 0, skipped: errors.length, errors };

  if (dryRun) {
    summary.inserted = normalizedEntries.length;
    logger?.info?.('[importAdCampaignCatalog] dry-run result', summary);
    return summary;
  }

  if (!append) {
    const delRes = await AdCampaignCatalog.deleteMany({ catalogSlug: slug, venueSlug: venue });
    logger?.info?.('[importAdCampaignCatalog] cleared catalog', { catalogSlug: slug, venueSlug: venue, deleted: delRes.deletedCount });
  }

  for (const entry of normalizedEntries) {
    const filter = {
      catalogSlug: slug,
      venueSlug: venue,
      campaignSlug: entry.campaignSlug,
      slot: entry.slot,
      tariffCode: entry.tariffCode,
      zoneKey: entry.zoneKey,
      zoneType: entry.zoneType
    };
    const update = { $set: { ...entry, catalogSlug: slug, venueSlug: venue } };
    const result = await AdCampaignCatalog.updateOne(filter, update, { upsert: true });
    if (result.upsertedCount) summary.inserted += 1;
    else if (result.modifiedCount) summary.updated += 1;
    else summary.unchanged += 1;
  }

  logger?.info?.('[importAdCampaignCatalog] done', summary);
  return summary;
}
