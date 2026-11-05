// Shared logic for scripts/{00-system,03-season,04-event,05-partner}-management/set-*-custo.js
// — each of those scripts differs only in where the target file lands.
import fs from 'fs';
import path from 'path';
import { classifyKey, validateValueShape } from './customization-schema.js';

export function parseArgs(argv) {
  const out = {};
  argv.forEach(tok => {
    if (!tok.startsWith('--')) return;
    const eq = tok.indexOf('=');
    if (eq === -1) out[tok.slice(2)] = true;
    else out[tok.slice(2, eq)] = tok.slice(eq + 1);
  });
  return out;
}

function loadCustoFile(sourcePath) {
  const abs = path.resolve(sourcePath);
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
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.error('Customization file must be a flat JSON object of "key": value pairs.');
    process.exit(1);
  }
  return { abs, data };
}

function checkKeys(data) {
  const notes = [];
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_')) continue; // e.g. "_comment" in data_references templates
    const status = classifyKey(key);
    if (status === 'unknown') {
      notes.push(`  ⚠ "${key}" is not a recognized customization key — likely a typo. It will be written, but no page will read it. See data_references/README.md > Customization files.`);
    } else if (status === 'unused') {
      notes.push(`  ℹ "${key}" is a known key but isn't read by any route today — see scripts/lib/customization-schema.js.`);
    }
    const shape = validateValueShape(value);
    if (!shape.ok) {
      notes.push(`  ⚠ "${key}": ${shape.reason}`);
    }
  }
  return notes;
}

function printDiff(previous, next) {
  if (!previous) {
    console.log('  (new file)');
    return;
  }
  const added = Object.keys(next).filter(k => !(k in previous));
  const removed = Object.keys(previous).filter(k => !(k in next));
  const changed = Object.keys(next).filter(k => k in previous && JSON.stringify(previous[k]) !== JSON.stringify(next[k]));
  if (added.length) console.log('  + added:  ', added.join(', '));
  if (removed.length) console.log('  - removed:', removed.join(', '));
  if (changed.length) console.log('  ~ changed:', changed.join(', '));
  if (!added.length && !removed.length && !changed.length) console.log('  (no change from existing file)');
}

// sourcePath: JSON file to read (operator's --file argument)
// targetPath: where it lands under data/customization/
// scopeLabel: human label for the confirmation line ("Event", "Partner", ...)
export function writeCustoFile({ sourcePath, targetPath, scopeLabel, dryRun = false }) {
  const { data: raw } = loadCustoFile(sourcePath);

  // Les clés en «_» annotent les gabarits de data_references (« _comment » y
  // explique quoi copier). Elles n'ont aucun sens une fois le fichier en place :
  // aucune page ne les lit, et le texte d'aide décrit alors un fichier qui n'est
  // plus celui qu'on regarde. On les laisse au gabarit.
  const data = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
  const dropped = Object.keys(raw).filter(k => k.startsWith('_'));
  if (dropped.length) {
    console.log(`  (annotation(s) de gabarit non recopiée(s) : ${dropped.join(', ')})`);
  }

  const notes = checkKeys(data);
  if (notes.length) {
    console.log(`\n${notes.length} note(s):`);
    notes.forEach(n => console.log(n));
  }

  let previous = null;
  if (fs.existsSync(targetPath)) {
    try { previous = JSON.parse(fs.readFileSync(targetPath, 'utf8')); } catch { /* treat as no previous */ }
  }
  console.log('');
  printDiff(previous, data);

  if (dryRun) {
    console.log(`\n🧪 Dry-run — would write to ${targetPath} (nothing written).`);
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(data, null, 2) + '\n');
  console.log(`\n✓ ${scopeLabel} customization written to ${targetPath}`);
}
