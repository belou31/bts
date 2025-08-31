// src/utils/email-template.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const SRC_ROOT   = path.resolve(__dirname, '..'); // src/

function defaultTemplate() {
  return `<!doctype html><meta charset="utf-8"><title>Confirmation</title>
  <p>Bonjour {{payerFirstName}} {{payerLastName}},</p>
  <p>Votre commande <b>{{orderId}}</b> a été confirmée.</p>
  {{haOrderBlock}}
  <p>Saison: {{seasonCode}} — Lieu: {{venueSlug}}</p>
  <p>Total: {{totalEuro}} € — {{installmentsInfo}}</p>
  <ul>{{linesHtml}}</ul>
  <p>Les billets seront envoyés match par match à {{payerEmail}}.</p>`;
}

function resolveTemplatePath(nameOrPath) {
  if (!nameOrPath) {
    return path.join(SRC_ROOT, 'templates', 'email', 'renew-confirmation.html');
  }
  if (nameOrPath.endsWith('.html')) {
    // chemin relatif (depuis la racine du projet) ou absolu
    if (path.isAbsolute(nameOrPath)) return nameOrPath;
    // remonter d'un cran: src/.. = racine projet
    return path.resolve(SRC_ROOT, '..', nameOrPath);
  }
  // nom court => repertoire standard
  return path.join(SRC_ROOT, 'templates', 'email', `${nameOrPath}.html`);
}

export async function renderEmailTemplate(templateNameOrPath, vars = {}) {
  const p = resolveTemplatePath(templateNameOrPath);
  let html;
  try {
    html = await fs.readFile(p, 'utf8');
  } catch {
    html = defaultTemplate();
  }
  // remplacements {{var}}
  return html.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}
