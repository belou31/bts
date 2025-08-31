#!/usr/bin/env node
// ESM
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

import { renderEmailTemplate } from '../../src/utils/email-template.js';
import { sendMail } from '../../src/loaders/mailer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '../..'); // projet
const SRC        = path.join(ROOT, 'src');

function die(msg, code=1){ console.error(msg); process.exit(code); }

function parseArgs(argv){
  const args = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
    else if (a.startsWith('--')) args[a.slice(2)] = true;
  }
  return args;
}

// CSV minimaliste (séparateur ',' ; guillemets "...")
function splitCsvLine(line) {
  const out = [];
  let cur = '', inq = false;
  for (let i=0;i<line.length;i++){
    const c = line[i];
    if (c === '"') {
      if (inq && line[i+1] === '"') { cur+='"'; i++; }
      else inq = !inq;
    } else if (c === ',' && !inq) {
      out.push(cur); cur='';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function indexHeaders(hdrs) {
  const map = {};
  hdrs.forEach((h,i) => { map[h.trim().toLowerCase()] = i; });
  return (nameArr) => {
    for (const n of nameArr) {
      const idx = map[n.toLowerCase()];
      if (idx != null) return idx;
    }
    return -1;
  };
}

function isEmail(s=''){ return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s).trim()); }

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function buildSeatsBlock(seatIdsStr) {
  const seats = String(seatIdsStr||'').split(/[;|,]/).map(s=>s.trim()).filter(Boolean);
  if (!seats.length) return '';
  const lis = seats.map(s => `<li>${s}</li>`).join('');
  return `<h2>Vos sièges concernés</h2><ul>${lis}</ul>`;
}

function buildDeadlineBlock(deadline) {
  if (!deadline) return '';
  return `<p><b>Date limite :</b> ${deadline}</p>`;
}

async function main() {
  const args = parseArgs(process.argv);
  const csvPath = args.csv || args.file || 'renew-groups.csv';
  const subject = args.subject || process.env.EMAIL_SUBJECT_RENEW_INVITE || 'Renouvellement d’abonnement';
  const limit   = args.limit ? Number(args.limit) : Infinity;
  const offset  = args.offset ? Number(args.offset) : 0;
  const delayMs = args.delay  ? Number(args.delay)  : 800;  // anti-throttle Gmail
  const dryRun  = String(args.dryRun || args['dry-run'] || '').toLowerCase() === 'true' || false;

  const templateName = process.env.EMAIL_TEMPLATE_RENEW_INVITE || 'renew-invite';
  const seasonCode = process.env.SEASON_CODE || '';
  const venueSlug  = process.env.VENUE_SLUG || '';
  const clubName   = process.env.CLUB_NAME || 'Bélougas Toulouse-Blagnac';
  const deadline   = process.env.RENEW_DEADLINE || '';

  if (!fs.existsSync(csvPath)) {
    die(`CSV introuvable: ${csvPath}`);
  }

  // Lecture CSV en streaming
  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath, 'utf8'),
    crlfDelay: Infinity
  });

  let lineNum = 0, sent = 0, skipped = 0;
  let headers = [];
  let getIdx = null;

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;

    lineNum++;
    const cols = splitCsvLine(line);

    if (!headers.length) {
      headers = cols;
      getIdx = indexHeaders(headers);
      continue;
    }

    if (lineNum-1 <= offset) { skipped++; continue; }
    if (sent >= limit) break;

    // Champs possibles dans renew-groups.csv (on couvre large)
    const idxEmail = getIdx(['email','payerEmail','contact','mail']);
    const idxUrl   = getIdx(['link','url','renewUrl','renew_link','renew','base']);
    const idxFN    = getIdx(['firstName','first_name','payerFirstName']);
    const idxLN    = getIdx(['lastName','last_name','payerLastName']);
    const idxSeats = getIdx(['seats','seatIds','seats_list','seat_ids']);

    const email = idxEmail>=0 ? cols[idxEmail] : '';
    const renewUrl = idxUrl>=0 ? cols[idxUrl] : '';
    const firstName = idxFN>=0 ? cols[idxFN] : '';
    const lastName  = idxLN>=0 ? cols[idxLN] : '';
    const seatsRaw  = idxSeats>=0 ? cols[idxSeats] : '';

    if (!isEmail(email)) { 
      console.warn(`[skip L${lineNum}] email invalide: "${email}"`);
      continue;
    }
    if (!renewUrl) {
      console.warn(`[skip L${lineNum}] renewUrl manquant pour ${email}`);
      continue;
    }

    const html = await renderEmailTemplate(templateName, {
      firstName, lastName, email,
      seasonCode, venueSlug, clubName,
      renewUrl,
      seatsBlock: buildSeatsBlock(seatsRaw),
      deadlineBlock: buildDeadlineBlock(deadline)
    });

    const mail = {
      to: email,
      subject,
      html
    };

    if (dryRun) {
      console.log(`[dry-run] ${email} <- ${subject}`);
    } else {
      try {
        await sendMail(mail);
        console.log(`[ok] ${email}`);
      } catch (e) {
        console.error(`[ERR] ${email}:`, e.message || e);
      }
      await sleep(delayMs);
    }
    sent++;
  }

  console.log(`Done. sent=${sent} skipped=${skipped}, from CSV=${csvPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
