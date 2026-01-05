#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

function usage() {
  console.error('Usage: node scripts/05-partner-management/set-partner-custo.js --partner=<slug> --file=customization.json [--season=<code>] [--event=<slug>]');
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  argv.forEach(tok => {
    if (!tok.startsWith('--')) return;
    const eq = tok.indexOf('=');
    if (eq === -1) {
      out[tok.slice(2)] = true;
    } else {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
    }
  });
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file;
  const partnerSlug = args.partner;
  const seasonCode = args.season;
  const eventSlug = args.event;
  if (!file || !partnerSlug) usage();

  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error('File not found:', abs);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    console.error('Invalid JSON:', err?.message || err);
    process.exit(1);
  }

  let targetDir = path.resolve(process.cwd(), 'data', 'customization', 'partners');
  if (seasonCode) {
    targetDir = path.join(targetDir, partnerSlug, 'seasons');
  } else if (eventSlug) {
    targetDir = path.join(targetDir, partnerSlug, 'events');
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const targetName = seasonCode ? `${seasonCode}.json` : eventSlug ? `${eventSlug}.json` : `${partnerSlug}.json`;
  const target = path.join(targetDir, targetName);
  fs.writeFileSync(target, JSON.stringify(data, null, 2));
  console.log(`✓ Partner customization written to ${target}`);
})();
