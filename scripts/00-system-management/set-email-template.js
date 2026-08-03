#!/usr/bin/env node
// Promotes an HTML file into data/templates/email/ and registers it in
// data/templates/templates.json under email.templates.<kind>.
//
// "kind" is what src/services/mailer.js's resolveOrderKind() resolves an
// Order to (renew/subscription/event/public) — see data_references/README.md
// > Email & ticket templates for the full flow.
//
// --theme=<name> writes a theme variant instead (<kind>-confirmation.<theme>.html)
// and does NOT touch templates.json — theme variants are picked up purely by
// file existence at send time, selected via the "theme" customization key
// (see resolveThemeForOrder() in src/services/customization.js). A themed
// file with no matching "theme" value set anywhere just sits unused.
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
import { parseArgs, copyTemplateFile, updateTemplatesConfig, printRestartReminder, readTemplatesConfig, KNOWN_EMAIL_KINDS } from '../lib/template-write.js';

function usage() {
  console.error(`Usage: node scripts/00-system-management/set-email-template.js --kind=<${KNOWN_EMAIL_KINDS.join('|')}|...> --file=<path.html> [--subject="..."] [--theme=<name>] [--target-file=<name.html>] [--dry-run]`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const kind = args.kind;
if (!args.file || !kind) usage();

if (!KNOWN_EMAIL_KINDS.includes(kind)) {
  console.log(`⚠ "${kind}" isn't one of the kinds an Order can actually resolve to today (${KNOWN_EMAIL_KINDS.join(', ')}) — see resolveOrderKind() in src/services/mailer.js. Writing it anyway, but no order will pick it up automatically.`);
}

const dryRun = Boolean(args['dry-run']);
const theme = args.theme ? String(args.theme).trim() : '';

// Theme suffix must apply to whatever base file this kind currently resolves
// to (it may already have been customized away from "<kind>-confirmation.html"),
// matching exactly what loadTemplateHtml()'s theme lookup does at send time.
function currentBaseEmailFile(kind) {
  const config = readTemplatesConfig();
  const configured = config?.email?.templates?.[kind]?.file;
  const base = configured ? path.basename(configured) : `${kind}-confirmation.html`;
  return base.endsWith('.html') ? base : `${base}.html`;
}

const targetFile = args['target-file'] || (theme
  ? (() => { const base = currentBaseEmailFile(kind); return `${base.slice(0, -'.html'.length)}.${theme}.html`; })()
  : `${kind}-confirmation.html`);
const targetPath = path.resolve(process.cwd(), 'data', 'templates', 'email', targetFile);

const { existed, changed, write } = copyTemplateFile({ sourcePath: args.file, targetPath });
console.log(existed
  ? (changed ? `  ~ email/${targetFile} will be overwritten (content differs)` : `  (no change — content identical to existing email/${targetFile})`)
  : `  (new file: email/${targetFile})`);

if (dryRun) {
  console.log(`🧪 Dry-run — would write ${targetPath} (nothing written).`);
} else if (changed) {
  write();
  console.log(`✓ Template file written to ${targetPath}`);
}

if (theme) {
  if (args.subject) {
    console.log(`ℹ --subject is ignored with --theme: subject text isn't theme-specific — it's still the "${kind}" kind's subject in templates.json. Use set-email-template.js --kind=${kind} --subject=... (no --theme) to change it.`);
  }
  console.log(`\nℹ No templates.json change needed — "${targetFile}" is picked up automatically whenever a resolved "theme" customization value equals "${theme}" for the order's season/event/partner context.`);
} else {
  updateTemplatesConfig({
    section: 'email',
    kind,
    patch: { file: `email/${targetFile}`, ...(args.subject ? { subject: args.subject } : {}) },
    dryRun
  });
}

if (!dryRun) printRestartReminder();
