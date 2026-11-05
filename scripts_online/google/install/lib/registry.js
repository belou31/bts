// Local record of Google Apps Script library projects created/updated by
// install-library.js — lets the admin console offer a picker for "Install
// Google Sheet BTS Menu" instead of copy-pasting a Script ID/version, and is
// the foundation for a later "update deployed projects" feature (not built
// yet — this just keeps the history needed for it).
//
// Lives in data/ (gitignored, instance-specific — DEV/INT/PROD each track
// their own deployments, this is not repo state).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// install/lib -> install -> google -> scripts_online -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const REGISTRY_PATH = path.resolve(REPO_ROOT, 'data', 'google-library-deployments.json');

export function readRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.libraries) ? parsed.libraries : [];
  } catch {
    return [];
  }
}

export function upsertLibrary({ scriptId, title, version, googleUser }) {
  const libraries = readRegistry();
  const now = new Date().toISOString();
  const existing = libraries.find((l) => l.scriptId === scriptId);
  if (existing) {
    if (title) existing.title = title;
    if (version) existing.latestVersion = version;
    existing.updatedAt = now;
    if (googleUser) existing.googleUser = googleUser;
    existing.history = Array.isArray(existing.history) ? existing.history : [];
    if (version) existing.history.push({ version, deployedAt: now });
  } else {
    libraries.push({
      scriptId,
      title: title || '',
      latestVersion: version || null,
      updatedAt: now,
      googleUser: googleUser || null,
      history: version ? [{ version, deployedAt: now }] : []
    });
  }
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ libraries }, null, 2) + '\n');
  return libraries;
}

// Best-effort: extract just the email claim from clasp's own stored OAuth
// state (~/.clasprc.json), for display/tracking only. That file holds real
// credentials (access/refresh tokens) — this must never read it for anything
// beyond the email, and never log/persist/return the tokens themselves.
// Two schemas seen in the wild, tried in order: clasp 2.x's
// { token: { id_token, ... } }, and clasp 3.x's multi-account
// { tokens: { default: { id_token, ... } } } (confirmed directly against a
// real ~/.clasprc.json — this is undocumented and not in clasp's own source
// comments, so treat as version-dependent and liable to shift again). Returns
// { email, reason } rather than throwing/silently returning null, so a
// caller can explain *why* detection failed instead of just leaving a blank.
export function getClaspGoogleUser() {
  const home = os.homedir() || process.env.HOME || process.env.USERPROFILE;
  if (!home) return { email: null, reason: 'répertoire personnel introuvable (HOME non défini)' };

  const rcPath = path.join(home, '.clasprc.json');
  let raw;
  try {
    raw = fs.readFileSync(rcPath, 'utf8');
  } catch {
    return { email: null, reason: `${rcPath} introuvable — clasp login a-t-il été fait pour cet utilisateur ?` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { email: null, reason: `${rcPath} n'est pas un JSON valide` };
  }

  const idToken = parsed?.token?.id_token || parsed?.tokens?.default?.id_token;
  if (typeof idToken !== 'string') {
    return { email: null, reason: `${rcPath} trouvé mais sans id_token reconnaissable (clé "token.id_token" ni "tokens.default.id_token" — structure clasp inattendue)` };
  }

  try {
    const payloadSegment = idToken.split('.')[1];
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    if (typeof payload.email === 'string') return { email: payload.email, reason: null };
    return { email: null, reason: 'id_token décodé mais sans claim "email" (scope email/profile accordé au login ?)' };
  } catch {
    return { email: null, reason: 'échec du décodage de token.id_token (JWT malformé)' };
  }
}
