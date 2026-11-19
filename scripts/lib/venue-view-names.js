// Display names for venue views (public/dynamic/venues/<slug>/views/<viewSlug>.svg).
// Views themselves stay pure static files, same as plan.svg — no Mongoose model,
// to avoid a DB record and a file on disk that can silently drift out of sync.
// This sidecar JSON is the one place a human-readable name is attached, written
// by import-venue-view.js and read by the admin monitor's venue tab.
// Lives in data/ (gitignored, instance-specific).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NAMES_PATH = path.resolve(REPO_ROOT, 'data', 'venue-views.json');

export function readVenueViewNames() {
  try {
    const raw = fs.readFileSync(NAMES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getVenueViewName(venueSlug, viewSlug) {
  const names = readVenueViewNames();
  return names?.[venueSlug]?.[viewSlug] || null;
}

export function setVenueViewName(venueSlug, viewSlug, name) {
  const names = readVenueViewNames();
  if (!names[venueSlug]) names[venueSlug] = {};
  if (name) {
    names[venueSlug][viewSlug] = name;
  } else {
    delete names[venueSlug][viewSlug];
    if (!Object.keys(names[venueSlug]).length) delete names[venueSlug];
  }
  fs.mkdirSync(path.dirname(NAMES_PATH), { recursive: true });
  fs.writeFileSync(NAMES_PATH, JSON.stringify(names, null, 2) + '\n');
  return names;
}
