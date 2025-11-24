#!/usr/bin/env node
/**
 * Disable or re-enable a season for public subscription.
 *
 * Usage:
 *   node scripts/03-season-management/deactivate-season.js <seasonCode>
 *   node scripts/03-season-management/deactivate-season.js <seasonCode> --reactivate
 *
 * Effect:
 *   - Sets both `isActive` and `active` on the target season.
 *   - Default: disables (sets to false). Use --reactivate to set to true.
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { Season } from '../../src/models/Season.js';

function parseArgs(argv) {
  const positional = [];
  const flags = new Set();
  for (const token of argv) {
    if (token.startsWith('--')) {
      flags.add(token.replace(/^--/, '').toLowerCase());
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

(async () => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const code = positional[0] || process.env.SEASON;
  if (!code) {
    console.error('Usage: node scripts/03-season-management/deactivate-season.js <seasonCode> [--reactivate]');
    process.exit(1);
  }

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('Missing MONGO_URI/MONGODB_URI');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const season = await Season.findOne({ code });
  if (!season) {
    console.error(`Season not found for code=${code}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const enable = flags.has('reactivate');
  season.isActive = enable;
  season.active = enable;
  await season.save();

  console.log(`✓ Season ${code} ${enable ? 're-activated' : 'disabled'} (active=${season.active}, isActive=${season.isActive})`);

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
