#!/usr/bin/env node
/**
 * Upsert a season and its phases.
 *
 * Usage:
 *   node scripts/02-season-generation/upsert-season.js <seasonCode> [--name="Saison ..."] [--venue=<slug>] [--active=true]
 *   node scripts/02-season-generation/upsert-season.js 2025-2026 --renewal-open="2025-08-01T00:00:00Z" --renewal-close="2025-09-15T22:00:00Z" --enable-renewal
 *
 * Phase options:
 *   --renewal-open=ISO_DATE   --renewal-close=ISO_DATE   --enable-renewal   --disable-renewal
 *   --tbh7-open=ISO_DATE      --tbh7-close=ISO_DATE      --enable-tbh7      --disable-tbh7
 *   --public-open=ISO_DATE    --public-close=ISO_DATE    --enable-public    --disable-public
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI: Mongo database connection (required)
 *   - SEASON (optional default code)
 *   - VENUE  (optional default venue)
 *
 * Template:
 *   - data/templates/env/.env.template
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import { Season } from '../../src/models/Season.js';

const PHASE_NAMES = ['renewal', 'tbh7', 'public'];

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

function parseDate(value, label) {
  if (value == null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for ${label}: "${value}"`);
  }
  return date;
}

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('Missing MONGO_URI/MONGODB_URI'); process.exit(1); }
  await mongoose.connect(uri);

  const { positional, options } = parseArgs(process.argv.slice(2));

  const code = positional[0] || process.env.SEASON || '2025-2026';
  if (!code) {
    console.error('Usage: node scripts/02-season-generation/upsert-season.js <seasonCode> [--name="..."] [--venue=<slug>]');
    process.exit(1);
  }

  let season = await Season.findOne({ code });
  const isNew = !season;
  if (!season) {
    season = new Season({ code, phases: [] });
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

  const venueOpt = options.venue ?? options.venueSlug ?? process.env.VENUE;
  if (venueOpt) {
    season.venueSlug = venueOpt;
  }

  season.phases = Array.isArray(season.phases) ? season.phases : [];

  const phasesByName = new Map(season.phases.map(p => [p.name, p]));
  for (const phaseName of PHASE_NAMES) {
    let phase = phasesByName.get(phaseName);
    if (!phase) {
      phase = { name: phaseName, enabled: true };
      phasesByName.set(phaseName, phase);
      season.phases.push(phase);
    }

    const openVal = options[`${phaseName}-open`];
    const closeVal = options[`${phaseName}-close`];
    const enableFlag = options[`enable-${phaseName}`];
    const disableFlag = options[`disable-${phaseName}`];

    if (openVal !== undefined) {
      const d = parseDate(openVal, `${phaseName} openAt`);
      phase.openAt = d;
    }
    if (closeVal !== undefined) {
      const d = parseDate(closeVal, `${phaseName} closeAt`);
      phase.closeAt = d;
    }

    if (enableFlag !== undefined) phase.enabled = true;
    if (disableFlag !== undefined) phase.enabled = false;
    if (phase.enabled == null) phase.enabled = true;
  }

  await season.save();

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
