// clasp is a real project dependency (package.json's `@google/clasp`), installed
// by the same `npm install` that provisions DEV/INT/PROD — not a separate global
// install left to each host. Resolve node_modules/.bin/clasp explicitly rather
// than relying on PATH, so admin-panel-triggered runs (which inherit the BTS
// server process's PATH, not an interactive shell's) find it reliably. Falls
// back to a bare "clasp" PATH lookup only if the local binary is somehow
// missing (e.g. a stray global install during a transition), so this doesn't
// hard-fail environments that haven't re-run `npm install` yet.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// install/lib -> install -> google -> scripts_online -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

export function resolveClaspBin() {
  const binName = process.platform === 'win32' ? 'clasp.cmd' : 'clasp';
  const localBin = path.join(REPO_ROOT, 'node_modules', '.bin', binName);
  return fs.existsSync(localBin) ? localBin : 'clasp';
}
