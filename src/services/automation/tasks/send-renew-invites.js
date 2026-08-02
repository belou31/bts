// src/services/automation/tasks/send-renew-invites.js
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { renderEmailTemplate } from '../../../utils/email-template.js';
import { sendMail } from '../../../loaders/mailer.js';
import { currentPaymentProviderLabel } from '../../payments/index.js';

const EMAIL_ALIASES = ['email', 'payerEmail', 'contact', 'mail'];
const URL_ALIASES = ['url', 'link', 'renewurl', 'renew_url', 'renew'];
const FIRST_NAME_ALIASES = ['firstName', 'first_name', 'payerFirstName'];
const LAST_NAME_ALIASES = ['lastName', 'last_name', 'payerLastName'];
const SEATS_ALIASES = ['seats', 'seatIds', 'seat_ids', 'seats_list'];

const DEFAULT_SUBJECT = process.env.EMAIL_SUBJECT_RENEW_INVITE || 'Renouvellement d’abonnement';
const DEFAULT_TEMPLATE = process.env.EMAIL_TEMPLATE_RENEW_INVITE || 'renew-invite';

function stripBOM(input = '') {
  return String(input).replace(/^\uFEFF/, '');
}

function detectSeparator(headerLine, forced) {
  if (forced) return forced;
  const counts = (char) => (headerLine.match(new RegExp(`\\${char}`, 'g')) || []).length;
  const semi = counts(';');
  const comma = counts(',');
  return semi > comma ? ';' : ',';
}

function splitCsvLine(line, separator) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === separator && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.map((value) => value.trim());
}

function buildHeaderIndex(headerCells) {
  const lookup = new Map();
  headerCells.forEach((raw, columnIndex) => {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) return;
    lookup.set(key, columnIndex);
  });
  return (aliases) => {
    for (const alias of aliases) {
      const idx = lookup.get(String(alias || '').toLowerCase());
      if (idx != null) return idx;
    }
    return -1;
  };
}

function isValidEmail(value = '') {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value).trim());
}

function buildSeatsBlock(raw) {
  const seats = String(raw || '')
    .split(/[;|,]/)
    .map((seat) => seat.trim())
    .filter(Boolean);
  if (!seats.length) return '';
  const items = seats.map((seat) => `<li>${seat}</li>`).join('');
  return `<h2>Vos sièges concernés</h2><ul>${items}</ul>`;
}

function buildDeadlineBlock(deadline) {
  if (!deadline) return '';
  return `<p><b>Date limite :</b> ${deadline}</p>`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCsvPath(inputPath, context) {
  const logger = context?.logger;
  const trimmed = String(inputPath || '').trim();
  if (!trimmed) throw new Error('CSV path is required');

  const candidates = [];
  if (path.isAbsolute(trimmed)) {
    candidates.push(trimmed);
  }
  candidates.push(path.resolve(context.paths.root, trimmed));

  try {
    candidates.push(context.paths.resolve('inputs', trimmed));
  } catch {
    // ignore when resolution fails
  }

  const uniqueCandidates = Array.from(new Set(candidates));
  for (const candidate of uniqueCandidates) {
    if (fs.existsSync(candidate)) {
      logger?.debug?.('Resolved CSV path', { candidate });
      return candidate;
    }
  }

  throw new Error(
    `CSV file not found. Tried: ${uniqueCandidates.map((c) => `"${c}"`).join(', ')}`
  );
}

async function iterateCsv(filePath, { forcedSeparator }) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    throw new Error(`CSV path is not a file: ${filePath}`);
  }

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  let separator = ',';
  let header = null;
  let getIdx = null;

  for await (const rawLine of rl) {
    const line = stripBOM(String(rawLine || '').trim());
    if (!line) continue;
    separator = detectSeparator(line, forcedSeparator);
    header = splitCsvLine(line, separator);
    getIdx = buildHeaderIndex(header);
    break;
  }

  if (!header) {
    rl.close();
    throw new Error('CSV appears to be empty or missing a header row.');
  }

  async function* rowsGenerator() {
    for await (const rawLine of rl) {
      const line = stripBOM(String(rawLine || '').trim());
      if (!line) continue;
      yield splitCsvLine(line, separator);
    }
  }

  return {
    header,
    separator,
    getIdx,
    rows: rowsGenerator()
  };
}

export const sendRenewInvitesTask = {
  id: 'season.send-renew-invites',
  version: '1.0.0',
  summary: 'Envoie les invitations de renouvellement par e-mail à partir d’un CSV exporté.',
  chapter: '03 — Season Management',
  tags: ['renewal', 'email', 'season'],
  scopes: ['automation:jobs:write', 'automation:jobs:run', 'automation:renewals:write'],
  allowDryRun: true,
  schema: {
    type: 'object',
    required: [],
    properties: {
      csv: { type: 'string', description: 'Chemin vers le CSV des abonnés' },
      subject: { type: 'string', description: 'Objet de l’e-mail à envoyer' },
      limit: { type: 'integer', minimum: 1 },
      offset: { type: 'integer', minimum: 0 },
      delayMs: { type: 'integer', minimum: 0 },
      separator: { type: 'string', minLength: 1, maxLength: 1 },
      template: { type: 'string' },
      seasonCode: { type: 'string' },
      clubName: { type: 'string' },
      deadline: { type: 'string' },
      venue: { type: 'string' },
      fromName: { type: 'string' },
      providerLabel: { type: 'string' },
      invitees: {
        type: 'array',
        description: 'Liste inline des invitations (alternative au CSV)',
        items: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            renewUrl: { type: 'string' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            seats: { type: 'string' }
          }
        }
      }
    },
    additionalProperties: true
  },
  description: 'Lecture du CSV, rendu du template d’e-mail et envoi (ou dry-run) des invitations.',
  async validateParams(params = {}) {
    const hasInline = Array.isArray(params.invitees) && params.invitees.length > 0;
    if (!hasInline && !params.csv) {
      throw new Error('Fournissez soit un CSV (paramètre "csv"), soit des invitations inline ("invitees").');
    }
  },
  async handler(params = {}, context) {
    const logger = context?.logger;
    const dryRun = Boolean(context?.dryRun);

    const inlineInvitees = Array.isArray(params.invitees) ? params.invitees : [];
    const usingInline = inlineInvitees.length > 0;

    const csvPath = usingInline ? null : resolveCsvPath(params.csv, context);
    const subject = params.subject || params.emailSubject || DEFAULT_SUBJECT;
    const limit =
      params.limit != null ? Number(params.limit) : Number.POSITIVE_INFINITY;
    const offset = params.offset != null ? Math.max(Number(params.offset), 0) : 0;
    const delayMs = params.delayMs != null ? Math.max(Number(params.delayMs), 0) : 800;
    const forcedSeparator = params.separator || params.sep || '';
    const templateName = params.template || params.templateName || DEFAULT_TEMPLATE;
    const seasonCode = params.seasonCode || params.season || context?.env?.seasonCode || '';
    const venueSlug = params.venue || params.venueSlug || context?.env?.venueSlug || '';
    const clubName = params.clubName || context?.env?.clubName || 'Bélougas Toulouse-Blagnac';
    const deadline = params.deadline || process.env.RENEW_DEADLINE || '';
    const providerLabel =
      params.providerLabel || currentPaymentProviderLabel();

    logger?.info('Launching send-renew-invites task', {
      csvPath,
      inlineInvitees: usingInline ? inlineInvitees.length : 0,
      subject,
      limit: Number.isFinite(limit) ? limit : null,
      offset,
      delayMs,
      templateName,
      dryRun
    });

    let processed = 0;
    let sent = 0;
    let skippedInvalidEmail = 0;
    let skippedMissingUrl = 0;
    let skippedOffset = 0;
    let errors = 0;
    let iterator;
    let iteratorType = 'csv';

    if (usingInline) {
      iteratorType = 'inline';
      iterator = (async function* buildInlineIterator() {
        for (const invite of inlineInvitees) {
          yield invite;
        }
      })();
    } else {
      const csv = await iterateCsv(csvPath, { forcedSeparator });
      const header = csv.header;
      const getIdx = csv.getIdx;
      const separator = csv.separator;

      logger?.debug?.('CSV header loaded', {
        header,
        separator
      });

      const idxEmail = getIdx(EMAIL_ALIASES);
      const idxUrl = getIdx(URL_ALIASES);
      const idxFN = getIdx(FIRST_NAME_ALIASES);
      const idxLN = getIdx(LAST_NAME_ALIASES);
      const idxSeats = getIdx(SEATS_ALIASES);

      if (idxEmail === -1) {
        throw new Error('Colonne email introuvable dans le CSV.');
      }
      if (idxUrl === -1) {
        throw new Error('Colonne lien (renewUrl) introuvable dans le CSV.');
      }

      iterator = (async function* buildCsvIterator() {
        for await (const row of csv.rows) {
          yield {
            email: idxEmail >= 0 ? row[idxEmail] : '',
            renewUrl: idxUrl >= 0 ? row[idxUrl] : '',
            firstName: idxFN >= 0 ? row[idxFN] : '',
            lastName: idxLN >= 0 ? row[idxLN] : '',
            seats: idxSeats >= 0 ? row[idxSeats] : ''
          };
        }
      })();
    }

    for await (const entry of iterator) {
      const email = entry?.email || entry?.payerEmail || entry?.contact || entry?.mail || '';
      const renewUrl = entry?.renewUrl || entry?.url || entry?.link || entry?.renew || '';
      const firstName = entry?.firstName || entry?.payerFirstName || '';
      const lastName = entry?.lastName || entry?.payerLastName || '';
      const seatsRaw = entry?.seats || entry?.seatIds || entry?.seat_ids || entry?.seats_list || '';

      processed++;
      if (sent >= limit) {
        logger?.info('Limit reached, stopping iteration', { limit });
        break;
      }
      if (processed <= offset) {
        skippedOffset++;
        continue;
      }

      if (!isValidEmail(email)) {
        skippedInvalidEmail++;
        logger?.warn?.('Skipping row — invalid email', { email, processed });
        continue;
      }
      if (!renewUrl) {
        skippedMissingUrl++;
        logger?.warn?.('Skipping row — missing renewUrl', { email, processed });
        continue;
      }

      const seatsBlock = buildSeatsBlock(seatsRaw);
      const deadlineBlock = buildDeadlineBlock(deadline);

      const contextVars = {
        firstName,
        lastName,
        email,
        renewUrl,
        seatsBlock,
        deadlineBlock,
        seasonCode,
        venueSlug,
        clubName,
        paymentProviderLabel: providerLabel
      };

      let html;
      try {
        html = await renderEmailTemplate(templateName, contextVars);
      } catch (error) {
        errors++;
        logger?.error?.('Failed to render template', {
          error: error?.message,
          templateName,
          email
        });
        continue;
      }

      if (dryRun) {
        sent++;
        logger?.info?.('[dry-run] Invitation prête', { email, templateName });
        continue;
      }

      try {
        await sendMail({
          to: email,
          subject,
          html
        });
        sent++;
        logger?.info?.('Invitation envoyée', { email });
      } catch (error) {
        errors++;
        logger?.error?.('Erreur lors de l’envoi', {
          email,
          error: error?.message || error
        });
      }

      if (!dryRun && delayMs > 0 && sent < limit && iteratorType === 'csv') {
        await sleep(delayMs);
      }
    }

    const result = {
      csvPath,
      inlineInvitees: usingInline ? inlineInvitees.length : 0,
      subject,
      dryRun,
      counts: {
        processed,
        sent,
        skipped: {
          invalidEmail: skippedInvalidEmail,
          missingUrl: skippedMissingUrl,
          offset: skippedOffset
        },
        errors
      }
    };

    logger?.info('send-renew-invites completed', result);

    const summary = `Sent ${sent} / ${processed} invitations ${dryRun ? '(dry-run)' : ''}`;
    return { summary, payload: result };
  }
};
