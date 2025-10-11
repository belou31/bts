// scripts/01-initialization/venues/validate-svg.js
// Usage:
//   node scripts/01-initialization/venues/validate-svg.js \
//     --svg src/public/static/venues/patinoire-blagnac/plan.svg \
//     --selectors "TBH7:#zone-tbh7,TBH7-VIRAGE:#zone-tbh7-virage,DEBOUT:#zone-debout" \
//     --min-seats 500 \
//     --fail-on-missing
//
// Notes:
// - ESM (package.json: { "type": "module" })
// - Cheerio v1+: import { load } from 'cheerio'

import { readFile } from 'fs/promises';
import { load } from 'cheerio';

function getArg(name, def = undefined) {
  const i = process.argv.findIndex(a => a === `--${name}`);
  if (i >= 0) return process.argv[i + 1] ?? '';
  // boolean flags (present without value)
  const present = process.argv.some(a => a === `--${name}`);
  return present ? true : def;
}

function parseSelectors(arg) {
  // format attendu: "TBH7:#zone-tbh7,TBH7-VIRAGE:#zone-tbh7-virage,DEBOUT:#zone-debout"
  const map = new Map();
  if (!arg) return map;
  arg.split(',').map(s => s.trim()).filter(Boolean).forEach(entry => {
    const idx = entry.indexOf(':');
    if (idx === -1) return;
    const key = entry.slice(0, idx).trim();
    const sel = entry.slice(idx + 1).trim();
    if (key && sel) map.set(key, sel);
  });
  return map;
}

function reportLine(label, value, ok = true) {
  const icon = ok ? '✓' : '✗';
  console.log(`${icon} ${label}: ${value}`);
}

async function main() {
  const svgPath = getArg('svg', 'src/public/static/venues/patinoire-blagnac/plan.svg');
  const selectorsArg = getArg('selectors', 'TBH7:#zone-tbh7,TBH7-VIRAGE:#zone-tbh7-virage,DEBOUT:#zone-debout');
  const minSeats = Number(getArg('min-seats', 0)) || 0;
  const failOnMissing = Boolean(getArg('fail-on-missing', false));

  const selMap = parseSelectors(selectorsArg);
  if (selMap.size === 0) {
    console.error('No selectors provided. Use --selectors "KEY:#css,KEY2:#css2"');
    process.exit(2);
  }

  const svgString = await readFile(svgPath, 'utf8');
  const $ = load(svgString, { xmlMode: true });

  console.log(`SVG: ${svgPath}`);
  console.log(`Selectors: ${[...selMap.entries()].map(([k,v]) => `${k}:${v}`).join(', ')}`);

  // --- Seats count
  const $seats = $('[data-seat-id]');
  const totalSeats = $seats.length;
  reportLine('Total seats (data-seat-id)', totalSeats, true);

  // Optional: pattern check (very permissive -> ZONE-ROW-###)
  const rx = /^[A-Z0-9-]+-[A-Z0-9]+-\d{1,4}$/i;
  let bad = 0;
  $seats.each((_, el) => {
    const sid = $(el).attr('data-seat-id') || '';
    if (!rx.test(sid)) bad++;
  });
  if (bad > 0) {
    reportLine('Seat-id pattern mismatches', bad, false);
  } else {
    reportLine('Seat-id pattern mismatches', 0, true);
  }

  // --- Zone selectors presence
  const missing = [];
  for (const [zoneKey, selector] of selMap) {
    const count = $(selector).length;
    const ok = count > 0;
    reportLine(`Zone "${zoneKey}" selector "${selector}"`, `${count} match(es)`, ok);
    if (!ok) missing.push({ zoneKey, selector });
  }

  // --- Thresholds / exit code
  let failed = false;
  if (minSeats > 0 && totalSeats < minSeats) {
    console.error(`✗ Not enough seats: found ${totalSeats}, required >= ${minSeats}`);
    failed = true;
  }
  if (failOnMissing && missing.length > 0) {
    console.error(`✗ Missing zone selectors: ${missing.map(m => `${m.zoneKey}:${m.selector}`).join(', ')}`);
    failed = true;
  }

  if (failed) process.exit(1);
  console.log('All checks passed.');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
