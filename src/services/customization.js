import fs from 'fs';
import path from 'path';

const CUSTOM_BASE = path.resolve(process.cwd(), 'data', 'customization');

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function mergePrefs(...objs) {
  return objs.reduce((acc, obj) => Object.assign(acc, obj || {}), {});
}

export function loadCustomization({ seasonCode = '', eventSlug = '', partnerSlug = '' } = {}) {
  const defaultPath = path.join(CUSTOM_BASE, 'default.json');
  const seasonPath  = seasonCode ? path.join(CUSTOM_BASE, 'seasons', `${seasonCode}.json`) : null;
  const eventPath   = eventSlug ? path.join(CUSTOM_BASE, 'events', `${eventSlug}.json`) : null;
  const partnerPath = partnerSlug ? path.join(CUSTOM_BASE, 'partners', `${partnerSlug}.json`) : null;
  const partnerSeasonPath = (partnerSlug && seasonCode)
    ? path.join(CUSTOM_BASE, 'partners', partnerSlug, 'seasons', `${seasonCode}.json`)
    : null;
  const partnerEventPath = (partnerSlug && eventSlug)
    ? path.join(CUSTOM_BASE, 'partners', partnerSlug, 'events', `${eventSlug}.json`)
    : null;

  const base    = readJson(defaultPath);
  const season  = seasonPath  ? readJson(seasonPath)  : {};
  const event   = eventPath   ? readJson(eventPath)   : {};
  const partner = partnerPath ? readJson(partnerPath) : {};
  const partnerSeason = partnerSeasonPath ? readJson(partnerSeasonPath) : {};
  const partnerEvent  = partnerEventPath  ? readJson(partnerEventPath)  : {};

  return mergePrefs(base, season, event, partner, partnerSeason, partnerEvent);
}
