// src/utils/tariff-filter.js
import { matchesChannel } from './channel-scopes.js';

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function dedupeTariffs(list = []) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const code = normalizeCode(t?.code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(t);
  }
  return out;
}

/**
 * Filters tariffs and prices by channel context, removes duplicates (by code),
 * and discards prices whose tariff code is not present in the filtered tariff catalog.
 * Optionally falls back to the "public" channel when nothing matches for partner flows.
 */
export function filterTariffsAndPricesByChannel(tariffs = [], prices = [], channelCtx = { kind: 'public' }, { fallbackToPublic = false } = {}) {
  const apply = (ctx) => {
    // 1) Channel-filter + dedupe tariffs
    let filteredTariffs = dedupeTariffs(
      (tariffs || []).filter(t => matchesChannel(t?.channels, ctx))
    );
    // 2) Channel-filter prices
    let filteredPrices = (prices || []).filter(p => matchesChannel(p?.channels, ctx));
    // 3) Keep only tariffs that have at least one price entry
    const priceCodes = new Set(filteredPrices.map(p => normalizeCode(p.tariffCode)));
    filteredTariffs = filteredTariffs.filter(t => priceCodes.has(normalizeCode(t.code)));
    // 4) Drop prices whose code is not in the remaining tariffs
    const allowed = new Set(filteredTariffs.map(t => normalizeCode(t.code)));
    filteredPrices = filteredPrices.filter(p => allowed.has(normalizeCode(p.tariffCode)));
    return { tariffs: filteredTariffs, prices: filteredPrices };
  };

  let result = apply(channelCtx || { kind: 'public' });
  if (fallbackToPublic && (!result.prices.length || !result.tariffs.length) && (channelCtx?.kind || '') !== 'public') {
    result = apply({ kind: 'public' });
  }
  return result;
}
