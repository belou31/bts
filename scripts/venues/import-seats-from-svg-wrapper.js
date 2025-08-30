#!/usr/bin/env node
// scripts/venues/import-seats-from-svg-wrapper.js

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { spawnSync } from 'child_process';

import dotenv from 'dotenv';
dotenv.config();


const [, , slug, svgPath] = process.argv;
if (!slug || !svgPath) {
  console.error('Usage: node scripts/venues/import-seats-from-svg-wrapper.js <slug> <path/to/plan.svg>');
  process.exit(1);
}
const abs = path.resolve(svgPath);
if (!fs.existsSync(abs)) {
  console.error('Plan introuvable:', abs);
  process.exit(1);
}

// ⚠️ Le script existant attendait (svgPath, venueSlug)
const res = spawnSync(process.execPath,
  ['scripts/venues/import-seats-from-svg.js', abs, slug],
  { stdio: 'inherit' }
);
process.exit(res.status ?? 0);
