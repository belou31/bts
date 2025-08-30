#!/usr/bin/env node
/**
 * Usage:
 *   node scripts/admin/upsert-season.js <seasonCode> --name="Saison ..." --renewal-open --renewal-close
 *   node scripts/admin/upsert-season.js 2025-2026 --name="Saison 2025-2026" --renewal-open="2025-08-01T00:00:00Z" --renewal-close="2025-09-15T22:00:00Z"
 *   node scripts/admin/upsert-season.js 2025-2026 --enable-renewal --disable-public
 */
import mongoose from 'mongoose';

import { Season } from '../../src/models/Season.js';

import dotenv from 'dotenv';
dotenv.config();

function parseArgs(argv){
  const [,, seasonCode, ...rest] = argv;
  const opts = { seasonCode, name:null, renewalOpen:null, renewalClose:null, enable:null, disable:null };
  for (const t of rest) {
    let m = /^--name=(.+)$/.exec(t); if (m) { opts.name = m[1]; continue; }
    m = /^--renewal-open=(.+)$/.exec(t); if (m) { opts.renewalOpen = new Date(m[1]); continue; }
    m = /^--renewal-close=(.+)$/.exec(t); if (m) { opts.renewalClose = new Date(m[1]); continue; }
    if (t === '--enable-renewal')  opts.enable = 'renewal';
    if (t === '--disable-renewal') opts.disable = 'renewal';
    if (t === '--enable-public')   opts.enable = 'public';
    if (t === '--disable-public')  opts.disable = 'public';
  }
  return opts;
}

(async () => {
  const { seasonCode, name, renewalOpen, renewalClose, enable, disable } = parseArgs(process.argv);
  if (!seasonCode) { console.error('Usage: node scripts/admin/upsert-season.js <seasonCode> [options]'); process.exit(1); }

  const uri = process.env.MONGO_URI; if (!uri) { console.error('Missing MONGO_URI'); process.exit(1); }
  await mongoose.connect(uri);

  const update = {};
  if (name) update.name = name;

  let season = await Season.findOne({ code: seasonCode });
  if (!season) {
    season = new Season({ code: seasonCode, active: true, phases: [] });
  }
  if (name) season.name = name;

  // ensure phases exists
  const need = (n) => season.phases.find(p => p.name === n) || season.phases.push({ name:n, enabled:true }) && season.phases.find(p => p.name===n);

  if (renewalOpen || renewalClose) {
    const pr = need('renewal');
    if (renewalOpen)  pr.openAt  = renewalOpen;
    if (renewalClose) pr.closeAt = renewalClose;
  }
  if (enable)  { const p = need(enable);  p.enabled = true; }
  if (disable) { const p = need(disable); p.enabled = false; }

  await season.save();
  console.log('✓ Season upserted:', { code: season.code, name: season.name, phases: season.phases });
  await mongoose.disconnect();
})();
