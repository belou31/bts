#!/usr/bin/env node
/**
 * Wrapper to import seats from an SVG
 *
 * Ensures the legacy argument order (<slug> <plan.svg>) and spawns the main importer.
 *
 * Usage:
 *   node scripts/01-initialization/venues/import-seats-from-svg-wrapper.js <slug> <path/to/plan.svg>
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI: Mongo database connection (required by the child script)
 *
 * Templates:
 *   - data/templates/env/.env.template
 *   - data/templates/files/plan.svg
 */

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { spawnSync } from 'child_process';

import dotenv from 'dotenv';
dotenv.config();


const [, , slug, svgPath] = process.argv;
if (!slug || !svgPath) {
  console.error('Usage: node scripts/01-initialization/venues/import-seats-from-svg-wrapper.js <slug> <path/to/plan.svg>');
  process.exit(1);
}
const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');
const abs = (() => {
  const absolute = path.resolve(svgPath);
  if (fs.existsSync(absolute)) return absolute;
  const fromInputs = path.resolve(INPUT_DIR, svgPath);
  return fs.existsSync(fromInputs) ? fromInputs : absolute;
})();
if (!fs.existsSync(abs)) {
  console.error('Plan introuvable:', svgPath, '(cherché aussi dans data/inputs)');
  process.exit(1);
}

// Forward call using the canonical order (<venueSlug> <plan.svg>)
const res = spawnSync(process.execPath,
  ['scripts/01-initialization/venues/import-seats-from-svg.js', slug, abs],
  { stdio: 'inherit' }
);
process.exit(res.status ?? 0);
