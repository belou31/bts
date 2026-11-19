#!/usr/bin/env node
// Promotes an SVG file into data/templates/tickets/ (and optionally a logo
// into data/assets/) and registers it in data/templates/templates.json
// under tickets.templates.<kind>.
//
// "kind" is what buildTicketsPdfBuffer() in src/services/tickets-pdf.js
// resolves an Order to (event/subscription/public, or "default" as the
// catch-all) — see data_references/README.md > Email & ticket templates.
//
// Note: every kind points at the same tickets/ticket.svg file by default —
// if you only pass --kind without --target-file, a per-kind file name is
// used instead of overwriting that shared file for everyone; this script
// also warns if the resolved file is still shared with other kinds.
//
// --theme=<name> writes a theme variant instead and does NOT touch
// templates.json — see resolveThemeForOrder() in src/services/customization.js.
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
import { parseArgs, copyTemplateFile, updateTemplatesConfig, printRestartReminder, readTemplatesConfig, KNOWN_TICKET_KINDS } from '../lib/template-write.js';

function usage() {
  console.error(`Usage: node scripts/00-system-management/set-ticket-template.js --kind=<${KNOWN_TICKET_KINDS.join('|')}|...> --file=<path.svg> [--logo=<path.svg>] [--theme=<name>] [--target-file=<name.svg>] [--dry-run]`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const kind = args.kind;
if (!args.file || !kind) usage();

if (!KNOWN_TICKET_KINDS.includes(kind)) {
  console.log(`⚠ "${kind}" isn't one of the kinds a ticket PDF can actually resolve to today (${KNOWN_TICKET_KINDS.join(', ')}) — see buildTicketsPdfBuffer() in src/services/tickets-pdf.js. Writing it anyway, but no order will pick it up automatically.`);
}

const dryRun = Boolean(args['dry-run']);
const theme = args.theme ? String(args.theme).trim() : '';

// Theme suffix must apply to whatever base file this kind currently resolves
// to (default.file for "default", or its own entry otherwise), matching
// exactly what resolveTicketFile()'s theme lookup does at send time.
function currentBaseTicketFile(kind) {
  const config = readTemplatesConfig();
  const templates = config?.tickets?.templates || {};
  const configured = templates[kind]?.file || (kind === 'default' ? null : templates.default?.file);
  const base = configured ? path.basename(configured) : 'ticket.svg';
  return base.endsWith('.svg') ? base : `${base}.svg`;
}

const targetFile = args['target-file'] || (theme
  ? (() => { const base = currentBaseTicketFile(kind); return `${base.slice(0, -'.svg'.length)}.${theme}.svg`; })()
  : (kind === 'default' ? 'ticket.svg' : `ticket-${kind}.svg`));
const targetPath = path.resolve(process.cwd(), 'data', 'templates', 'tickets', targetFile);

const { existed, changed, write } = copyTemplateFile({ sourcePath: args.file, targetPath });
console.log(existed
  ? (changed ? `  ~ tickets/${targetFile} will be overwritten (content differs)` : `  (no change — content identical to existing tickets/${targetFile})`)
  : `  (new file: tickets/${targetFile})`);

if (dryRun) {
  console.log(`🧪 Dry-run — would write ${targetPath} (nothing written).`);
} else if (changed) {
  write();
  console.log(`✓ Template file written to ${targetPath}`);
}

let logoPatch = {};
if (args.logo && !theme) {
  const logoTargetName = path.basename(args.logo);
  const logoTargetPath = path.resolve(process.cwd(), 'data', 'assets', logoTargetName);
  const logoResult = copyTemplateFile({ sourcePath: args.logo, targetPath: logoTargetPath });
  console.log(logoResult.existed
    ? (logoResult.changed ? `  ~ data/assets/${logoTargetName} (logo) will be overwritten` : `  (logo unchanged: data/assets/${logoTargetName})`)
    : `  (new logo file: data/assets/${logoTargetName})`);
  if (dryRun) {
    console.log(`🧪 Dry-run — would write ${logoTargetPath} (nothing written).`);
  } else if (logoResult.changed) {
    logoResult.write();
    console.log(`✓ Logo file written to ${logoTargetPath}`);
  }
  logoPatch = { logo: `assets/${logoTargetName}` };
} else if (args.logo && theme) {
  console.log(`ℹ --logo is ignored with --theme: the ticket SVG has no separate config entry to hold a themed logo path — embed the themed logo directly in the SVG file itself.`);
}

if (theme) {
  console.log(`\nℹ No templates.json change needed — "${targetFile}" is picked up automatically whenever a resolved "theme" customization value equals "${theme}" for the order's season/event/partner context.`);
} else {
  updateTemplatesConfig({
    section: 'tickets',
    kind,
    patch: { file: `tickets/${targetFile}`, ...logoPatch },
    dryRun
  });
}

if (!dryRun) printRestartReminder();
