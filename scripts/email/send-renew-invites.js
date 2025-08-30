// scripts/email/send-renew-invites.js
// Usage:
//  node -r dotenv/config scripts/email/send-renew-invites.js path/to/renew-groups.csv \
//    --season=2025-2026 --venue=patinoire-blagnac --fromName="TBHC Billetterie" \
//    --dry           # pour dry-run (aucun envoi)
//  dotenv_config_path=.env.int  # (conseillé en INT/PROD)

import fs from 'fs';
import path from 'path';

import { sendMail, renderRenewInvite } from '../../src/loaders/mailer.js';

import dotenv from 'dotenv';
dotenv.config();


function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--')) {
      const [k, v] = a.replace(/^--/, '').split('=');
      args[k] = v == null ? true : v;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(ln => {
    const cells = splitCsvLine(ln);
    const obj = {};
    headers.forEach((h, i) => obj[h] = cells[i] ?? '');
    return obj;
  });
}
function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i=0; i<line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') { q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const args = parseArgs(process.argv);
  const csvPath = args._[0];
  if (!csvPath) {
    console.error('Usage: node scripts/email/send-renew-invites.js <renew-groups.csv> [--season=2025-2026] [--venue=patinoire-blagnac] [--fromName="TBHC Billetterie"] [--dry]');
    process.exit(1);
  }
  const DRY = !!args.dry;
  const seasonCode = args.season || '';
  const venueSlug  = args.venue  || '';
  const fromName   = args.fromName || process.env.FROM_NAME || 'TBHC Billetterie';

  const raw = fs.readFileSync(path.resolve(csvPath), 'utf8');
  const rows = parseCsv(raw);
  if (!rows.length) {
    console.error('CSV vide ou illisible.');
    process.exit(2);
  }

  let sent = 0, skipped = 0, errors = 0;
  for (const row of rows) {
    const email = row.email || row.Email || row.to || '';
    const link  = row.link  || row.Link  || '';
    const seats = (row.seats || row.Seats || row.seatIds || '').split(/[;,]\s*/).filter(Boolean);

    if (!email || !link) { skipped++; continue; }

    const html = renderRenewInvite({ seasonCode, venueSlug, link, seats, clubName: fromName });
    const subject = `Renouvellement abonnement ${seasonCode || ''}`.trim();

    if (DRY) {
      console.log(`[DRY] to=${email} subject="${subject}" link=${link}`);
    } else {
      try {
        const r = await sendMail({ to: email, subject, html });
        if (r.skipped) { skipped++; }
        else { sent++; }
      } catch (e) {
        errors++;
        console.error('[ERR]', email, e.message);
      }
      // Rate limit (évite le throttle Gmail)
      await delay(1500);
    }
  }

  console.log(`Done. sent=${sent} skipped=${skipped} errors=${errors} dry=${DRY}`);
})();
