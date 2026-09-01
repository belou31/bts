// Shared logic for set-email-template.js / set-ticket-template.js.
// Both resource types share data/templates/templates.json (different
// top-level keys: email.templates.* vs tickets.templates.*), so updates
// merge into one key at a time rather than overwriting the whole file.
import fs from 'fs';
import path from 'path';

export { parseArgs } from './customization-write.js';

const TEMPLATES_ROOT = path.resolve(process.cwd(), 'data', 'templates');
const TEMPLATES_CONFIG_PATH = path.join(TEMPLATES_ROOT, 'templates.json');

// Kinds an Order can actually resolve to today — see resolveOrderKind() in
// src/services/mailer.js and the kind switch in buildTicketsPdfBuffer() in
// src/services/tickets-pdf.js. Kept here (not derived) so this stays a
// deliberate, readable list; update both if those functions change.
export const KNOWN_EMAIL_KINDS = ['renew', 'subscription', 'event', 'public'];
export const KNOWN_TICKET_KINDS = ['default', 'event', 'subscription', 'public'];

export function readTemplatesConfig() {
  try {
    return JSON.parse(fs.readFileSync(TEMPLATES_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// Which other kinds (in the same section) currently point at the same file —
// overwriting that file's content affects all of them, not just the one
// being targeted. All four ticket kinds alias to tickets/ticket.svg by
// default, so this matters in practice, not just in theory.
export function findKindsUsingFile(config, section, relFilePath) {
  const templates = config?.[section]?.templates || {};
  return Object.entries(templates)
    .filter(([, entry]) => entry?.file === relFilePath)
    .map(([k]) => k);
}

export function copyTemplateFile({ sourcePath, targetPath }) {
  const abs = path.resolve(sourcePath);
  if (!fs.existsSync(abs)) {
    console.error('File not found:', abs);
    process.exit(1);
  }
  const existed = fs.existsSync(targetPath);
  const previous = existed ? fs.readFileSync(targetPath, 'utf8') : null;
  const next = fs.readFileSync(abs, 'utf8');
  const changed = previous === null || previous !== next;
  return {
    existed,
    changed,
    write: () => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, next);
    }
  };
}

// section: 'email' | 'tickets'
export function updateTemplatesConfig({ section, kind, patch, dryRun }) {
  const config = readTemplatesConfig();
  if (!config[section]) config[section] = { templates: {} };
  if (!config[section].templates) config[section].templates = {};
  const previous = config[section].templates[kind] || null;
  const next = { ...previous, ...patch };
  for (const k of Object.keys(next)) {
    if (next[k] === undefined) delete next[k];
  }

  if (patch.file) {
    const sharedWith = findKindsUsingFile(config, section, patch.file).filter(k => k !== kind);
    if (sharedWith.length) {
      console.log(`\n⚠ ${patch.file} is also currently used by "${sharedWith.join('", "')}" (${section}) — overwriting its content changes those too.`);
    }
  }

  console.log('');
  if (!previous) {
    console.log(`  (new entry for "${kind}" in ${section}.templates)`);
  } else {
    const changedKeys = Object.keys(next).filter(k => JSON.stringify(next[k]) !== JSON.stringify(previous[k]));
    const removedKeys = Object.keys(previous).filter(k => !(k in next));
    if (changedKeys.length) console.log('  ~ changed:', changedKeys.join(', '));
    if (removedKeys.length) console.log('  - removed:', removedKeys.join(', '));
    if (!changedKeys.length && !removedKeys.length) console.log('  (no change)');
  }

  if (dryRun) {
    console.log(`\n🧪 Dry-run — would update ${TEMPLATES_CONFIG_PATH} (nothing written).`);
    return;
  }
  config[section].templates[kind] = next;
  fs.mkdirSync(TEMPLATES_ROOT, { recursive: true });
  fs.writeFileSync(TEMPLATES_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`✓ ${section}.templates.${kind} updated in ${TEMPLATES_CONFIG_PATH}`);
}

export function printRestartReminder() {
  console.log('\nℹ Templates are cached in-process — restart the server for this to take effect:');
  console.log('    node scripts/00-system-management/pm2-control.js --name=bts --action=restart');
}
