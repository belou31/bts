// src/utils/email-template.js
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const BUILTIN_EMAIL_DIR = path.resolve(ROOT_DIR, 'src', 'templates', 'email');
const CUSTOM_EMAIL_DIR = path.resolve(ROOT_DIR, 'data', 'customization', 'emails');

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function applyVars(template, context = {}) {
  if (!template) return '';
  return template.replace(/\{\{\s*([.\w]+)\s*\}\}/g, (_match, rawKey) => {
    const segments = String(rawKey || '').split('.');
    let value = context;
    for (const segment of segments) {
      if (value == null) break;
      value = value[segment];
    }
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

function candidateFilenames(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Template name is required');
  const candidates = new Set();

  if (trimmed.endsWith('.html') || trimmed.endsWith('.json')) {
    candidates.add(trimmed);
  } else {
    candidates.add(`${trimmed}.html`);
    candidates.add(`${trimmed}.json`);
  }
  return Array.from(candidates);
}

async function locateTemplate(name) {
  const filenames = candidateFilenames(name);
  for (const filename of filenames) {
    const withinCustom = path.join(CUSTOM_EMAIL_DIR, filename);
    if (await pathExists(withinCustom)) {
      return { path: withinCustom, type: path.extname(withinCustom).toLowerCase() };
    }
    const withinBuiltin = path.join(BUILTIN_EMAIL_DIR, filename);
    if (await pathExists(withinBuiltin)) {
      return { path: withinBuiltin, type: path.extname(withinBuiltin).toLowerCase() };
    }
  }
  return null;
}

async function renderJsonTemplate(templatePath, context) {
  const raw = await fs.readFile(templatePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON email template: ${templatePath} (${error.message})`);
  }
  const htmlSource = parsed.html || parsed.body || '';
  const subjectSource = parsed.subject || null;
  const textSource = parsed.text || null;
  const renderedHtml = applyVars(htmlSource, context);
  const renderedSubject = subjectSource ? applyVars(subjectSource, context) : null;
  const renderedText = textSource ? applyVars(textSource, context) : null;

  return {
    html: renderedHtml,
    subject: renderedSubject,
    text: renderedText,
    meta: {
      source: templatePath,
      type: 'json'
    }
  };
}

async function renderHtmlTemplate(templatePath, context) {
  const htmlSource = await fs.readFile(templatePath, 'utf8');
  return {
    html: applyVars(htmlSource, context),
    subject: null,
    text: null,
    meta: {
      source: templatePath,
      type: 'html'
    }
  };
}

/**
 * Renders an email template with {{variable}} placeholders using the provided context.
 * Supports both builtin HTML templates and JSON customization files stored under data/customization/emails.
 *
 * @param {string} name Template name (with or without extension)
 * @param {object} context Variable bindings available to the template
 * @param {object} [options]
 * @param {boolean} [options.includeMeta=false] Whether to return the rendered subject/text/meta alongside HTML
 * @returns {Promise<string|object>}
 */
export async function renderEmailTemplate(name, context = {}, options = {}) {
  const located = await locateTemplate(name);
  if (!located) {
    const filenames = candidateFilenames(name).join(', ');
    throw new Error(`Email template "${name}" not found. Tried: ${filenames}`);
  }

  const renderer = located.type === '.json' ? renderJsonTemplate : renderHtmlTemplate;
  const rendered = await renderer(located.path, context);

  if (options.includeMeta) return rendered;
  return rendered.html;
}

