#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

function usage() {
  console.error('Usage: node scripts/04-event-management/set-event-custo.js --event=<slug> --file=customization.json');
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
  const eventSlug = args.event;
  if (!file || !eventSlug) usage();

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

  const targetDir = path.resolve(process.cwd(), 'data', 'customization', 'events');
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, `${eventSlug}.json`);
  fs.writeFileSync(target, JSON.stringify(data, null, 2));
  console.log(`✓ Event customization written to ${target}`);
})();
