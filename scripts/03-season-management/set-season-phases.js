#!/usr/bin/env node
/**
 * Configure season phases (open/close dates and enabled flags).
 *
 * Usage:
 *   node scripts/03-season-management/set-season-phases.js <seasonCode> --phase=<renewal|tbh7|public> [--open=ISO] [--close=ISO] [--enabled=true|false]
 *   # Legacy (still supported):
 *   # --renewal-open/close/enabled, --tbh7-open/close/enabled, --public-open/close/enabled
 *
 * Notes:
 *   - Does not change season name/active flag; use create-season.js for creation/activation.
 *   - Missing phases are auto-created (enabled=true).
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { Season } from '../../src/models/Season.js';

const PHASE_NAMES = ['renewal', 'tbh7', 'public'];
function normalizePhase(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'renew' || v === 'renewal') return 'renewal';
  if (v === 'tbh7') return 'tbh7';
  if (v === 'public') return 'public';
  return null;
}

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
  const code = positional[0] || process.env.SEASON || '';
  if (!code) {
    console.error('Usage: node scripts/03-season-management/set-season-phases.js <seasonCode> --phase=<renewal|tbh7|public> [--open=ISO] [--close=ISO] [--enabled=true|false]');
    process.exit(1);
  }

  const targetPhase = normalizePhase(options.phase || positional[1] || null);

  const season = await Season.findOne({ code });
  if (!season) {
    console.error(`Season "${code}" not found. Create it first with create-season.js.`);
    process.exit(1);
  }

  season.phases = Array.isArray(season.phases) ? season.phases : [];
  const phasesByName = new Map(season.phases.map(p => [p.name, p]));
  let touched = 0;

  const phaseList = targetPhase ? [targetPhase] : PHASE_NAMES;

  for (const phaseName of phaseList) {
    let phase = phasesByName.get(phaseName);
    if (!phase) {
      phase = { name: phaseName, enabled: true };
      season.phases.push(phase);
    }

    const openVal = targetPhase
      ? (options.open ?? options[`${phaseName}-open`])
      : options[`${phaseName}-open`];
    const closeVal = targetPhase
      ? (options.close ?? options[`${phaseName}-close`])
      : options[`${phaseName}-close`];
    const enabledVal = targetPhase
      ? (options.enabled ?? options[`${phaseName}-enabled`])
      : options[`${phaseName}-enabled`];

    if (openVal !== undefined) {
      phase.openAt = parseDate(openVal, `${phaseName} openAt`);
      touched++;
    }
    if (closeVal !== undefined) {
      phase.closeAt = parseDate(closeVal, `${phaseName} closeAt`);
      touched++;
    }
    if (enabledVal !== undefined) {
      const parsed = parseBoolean(enabledVal, phase.enabled ?? true);
      phase.enabled = parsed;
      touched++;
    }
    if (phase.enabled == null) phase.enabled = true;
  }

  if (!touched) {
    console.warn('[set-season-phases] No changes detected (no phase options provided).');
  }

  await season.save();
  console.log('[set-season-phases] Updated phases:', season.phases);

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
