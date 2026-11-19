#!/usr/bin/env node
/**
 * Import a venue-specific view under public/dynamic/venues/<slug>/views/<viewSlug>.svg
 * (pure file copy — the SVG itself is never enriched or parsed).
 *
 * Optional --name gives it a human-readable display name, stored in the
 * sidecar data/venue-views.json (see scripts/lib/venue-view-names.js) rather
 * than a database record — views stay pure static files, same as plan.svg, so
 * there's no DB row that can drift out of sync with the file on disk.
 *
 * Usage:
 *   node scripts/01-venue-management/import-venue-view.js <venueSlug> <viewSlug> <path/to/view.svg> [--name="Vue partenaire"] [--overwrite]
 */

import fs from 'fs';
import path from 'path';
import process from 'process';
import { setVenueViewName } from '../lib/venue-view-names.js';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const venueSlug = args[0];
const viewSlug = args[1];
const srcFile = args[2];
const OVERWRITE = process.argv.includes('--overwrite');
const nameArg = process.argv.find(a => a.startsWith('--name='));
const viewName = nameArg ? nameArg.slice('--name='.length) : null;

if (!venueSlug || !viewSlug || !srcFile) {
  console.error('Usage: node scripts/01-venue-management/import-venue-view.js <venueSlug> <viewSlug> <path/to/view.svg> [--name="Vue partenaire"] [--overwrite]');
  process.exit(1);
}

const absSrc = path.resolve(process.cwd(), srcFile);
if (!fs.existsSync(absSrc)) {
  console.error(`[venue-view] Source file not found: ${absSrc}`);
  process.exit(1);
}

const destDir = path.resolve(process.cwd(), 'public', 'dynamic', 'venues', venueSlug, 'views');
const destFile = path.join(destDir, `${viewSlug}.svg`);

fs.mkdirSync(destDir, { recursive: true });

if (fs.existsSync(destFile) && !OVERWRITE) {
  console.error(`[venue-view] Destination already exists (${destFile}). Use --overwrite to replace.`);
  process.exit(1);
}

fs.copyFileSync(absSrc, destFile);
console.log(`[venue-view] Imported view "${viewSlug}" for venue "${venueSlug}" to ${destFile}`);

if (viewName) {
  setVenueViewName(venueSlug, viewSlug, viewName);
  console.log(`[venue-view] Name recorded: "${viewName}" (data/venue-views.json)`);
}
