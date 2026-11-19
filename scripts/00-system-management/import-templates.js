#!/usr/bin/env node
// Imports a single email/ticket template, or stages a logo asset, from an
// arbitrary file — no naming convention required, everything is explicit.
//
// --resource=email|ticket: thin dispatcher, delegates to the already-tested
// set-email-template.js / set-ticket-template.js based on --resource, so the
// same validation, diff preview, and templates.json handling applies.
//
// --resource=logo: just copies the file into data/assets/ (no kind, no
// templates.json write) — pair it with the "logo" customization key (see
// resolveLogoRefForOrder() in src/services/customization.js) to actually
// have a season/event/partner pick it up, the same way "theme" works.
import path from 'path';
import { execFileSync } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();
import { parseArgs, copyTemplateFile, KNOWN_EMAIL_KINDS, KNOWN_TICKET_KINDS } from '../lib/template-write.js';

const SET_EMAIL_SCRIPT = path.resolve(process.cwd(), 'scripts/00-system-management/set-email-template.js');
const SET_TICKET_SCRIPT = path.resolve(process.cwd(), 'scripts/00-system-management/set-ticket-template.js');

function usage() {
  console.error(`Usage: node scripts/00-system-management/import-templates.js --resource=<email|ticket|logo> --file=<path> [--kind=<kind>] [--theme=<name>] [--target-file=<name>] [--dry-run]

--resource=email  → --kind required: ${KNOWN_EMAIL_KINDS.join(', ')} (or a custom name, flagged as unusual)
--resource=ticket → --kind required: ${KNOWN_TICKET_KINDS.join(', ')} (or a custom name, flagged as unusual)
--resource=logo   → --kind/--theme ignored; just stages the file into data/assets/
--theme is optional — any name (e.g. halloween, partner01).
--file can be any path/filename — no naming convention required.`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const resource = String(args.resource || '').toLowerCase();
if (!args.file || !['email', 'ticket', 'logo'].includes(resource)) usage();

const dryRun = Boolean(args['dry-run']);

if (resource === 'logo') {
  const targetName = args['target-file'] || path.basename(args.file);
  const targetPath = path.resolve(process.cwd(), 'data', 'assets', targetName);
  const { existed, changed, write } = copyTemplateFile({ sourcePath: args.file, targetPath });
  console.log(existed
    ? (changed ? `  ~ data/assets/${targetName} will be overwritten (content differs)` : `  (no change — content identical to existing data/assets/${targetName})`)
    : `  (new file: data/assets/${targetName})`);

  if (dryRun) {
    console.log(`🧪 Dry-run — would write ${targetPath} (nothing written).`);
    process.exit(0);
  }
  if (changed) {
    write();
    console.log(`✓ Logo file written to ${targetPath}`);
  }
  console.log(`\nℹ This file alone changes nothing — set the "logo" customization key to "assets/${targetName}" (e.g. via set-partner-custo.js or set-event-custo.js) so a ticket actually picks it up. Without that, tickets keep using whatever they already resolve to.`);
  process.exit(0);
}

if (!args.kind) usage();

const script = resource === 'email' ? SET_EMAIL_SCRIPT : SET_TICKET_SCRIPT;
const scriptArgs = [script, `--kind=${args.kind}`, `--file=${args.file}`];
if (args.theme) scriptArgs.push(`--theme=${args.theme}`);
if (args['target-file']) scriptArgs.push(`--target-file=${args['target-file']}`);
if (dryRun) scriptArgs.push('--dry-run');

try {
  execFileSync('node', scriptArgs, { stdio: 'inherit' });
} catch {
  process.exit(1);
}
