#!/usr/bin/env node
/**
 * Upsert a season and its phases.
 *
 * Usage:
 *   node scripts/03-season-management/create-season.js <seasonCode> [--name="Saison ..."] [--active=true] [--venue=<slug>]
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI: Mongo database connection (required)
 *   - SEASON (optional default code)
 *
 * Template:
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import { Season } from '../../src/models/Season.js';

const PHASE_NAMES = ['renewal', 'fanclub', 'public'];

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      positional.push(raw);
      continue;
    }
    const body = raw.slice(2);
    if (!body) continue;
    const eq = body.indexOf('=');
    if (eq === -1) {
      options[body] = true;
    } else {
      const key = body.slice(0, eq);
      const value = body.slice(eq + 1);
      options[key] = value;
    }
  }
  return { positional, options };
}

function parseBoolean(value, fallback = null) {
  if (value === true || value === false) return value;
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true','1','yes','y','on','enable','enabled'].includes(normalized)) return true;
  if (['false','0','no','n','off','disable','disabled'].includes(normalized)) return false;
  return fallback;
}

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('Missing MONGO_URI/MONGODB_URI'); process.exit(1); }
  await mongoose.connect(uri);

  const { positional, options } = parseArgs(process.argv.slice(2));

  const code = positional[0] || process.env.SEASON || '2025-2026';
  if (!code) {
    console.error('Usage: node scripts/03-season-management/create-season.js <seasonCode> [--name="..."]');
    process.exit(1);
  }
  const venueSlug = options.venue || process.env.VENUE || '';

  let season = await Season.findOne({ code });
  const isNew = !season;
  if (!season) {
    season = new Season({
      code,
      phases: PHASE_NAMES.map(name => ({ name, enabled: true }))
    });
  }

  if (options.name) {
    season.name = options.name;
  } else if (isNew && !season.name) {
    season.name = `Saison ${code}`;
  }

  const activeOpt = options.active;
  if (activeOpt !== undefined) {
    season.active = parseBoolean(activeOpt, season.active ?? true);
  } else if (season.active == null) {
    season.active = true;
  }

  season.phases = Array.isArray(season.phases) && season.phases.length
    ? season.phases
    : PHASE_NAMES.map(name => ({ name, enabled: true }));

  await season.save();

  if (venueSlug) {
    season.venueSlug = venueSlug;
  }

  if (season.active) {
    await Season.updateMany({ _id: { $ne: season._id } }, { $set: { active: false } });
  }

  console.log('✓ Season upserted:', {
    code: season.code,
    name: season.name,
    active: season.active,
    venueSlug: season.venueSlug,
    phases: season.phases
  });

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
