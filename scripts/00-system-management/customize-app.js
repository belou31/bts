#!/usr/bin/env node
/**
 * Customize application assets (names, icons, email templates).
 *
 * Usage:
 *   node scripts/00-system-management/customize-app.js --name="Club Name" [--short-name="BTS"]
 *     [--favicon=favicon.ico] [--logo-svg=logo.svg] [--logo-png=logo.png]
 *     [--icon-192=icon-192.png] [--icon-512=icon-512.png]
 *     [--email-template=templates/order-confirmation.json]
 *     [--email-templates=dir/of/templates] [--dry-run] [--show]
 *
 * Behaviour:
 *   - Reads/writes data/customization/app.json to store display names, public asset paths, and email templates.
 *   - Copies favicon, logos, and app icons into src/public/static/img/.
 *   - Copies provided email template JSON files or folders into data/customization/emails/.
 *   - All command paths can be absolute or relative; relative paths resolve from repo root or data/inputs.
 *
 * Notes:
 *   - Use --dry-run to preview the operations without writing files.
 *   - Existing values are preserved when the corresponding option is not provided.
 */

import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const INPUT_ROOT = path.resolve(ROOT, 'data/inputs');
const CUSTOMIZATION_ROOT = path.resolve(ROOT, 'data/customization');
const EMAIL_DIR = path.join(CUSTOMIZATION_ROOT, 'emails');
const METADATA_PATH = path.join(CUSTOMIZATION_ROOT, 'app.json');
const PUBLIC_IMG_DIR = path.resolve(ROOT, 'src/public/static/img');
const PUBLIC_ROOT = path.resolve(ROOT, 'src/public');

function parseArgs(argv) {
  const options = {};
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const eqIdx = token.indexOf('=');
    const key = token.slice(2, eqIdx > -1 ? eqIdx : undefined);
    let value = true;

    if (eqIdx > -1) {
      value = token.slice(eqIdx + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    }

    if (Object.prototype.hasOwnProperty.call(options, key)) {
      const prev = options[key];
      if (Array.isArray(prev)) prev.push(value);
      else options[key] = [prev, value];
    } else {
      options[key] = value;
    }
  }

  return { options, positional };
}

function usage() {
  console.log(`Usage:
  node scripts/00-system-management/customize-app.js --name="Club Name"
    [--short-name="BTS"] [--favicon=favicon.ico]
    [--logo-svg=logo.svg] [--logo-png=logo.png]
    [--icon-192=icon-192.png] [--icon-512=icon-512.png]
    [--email-template=template.json] [--email-templates=path/to/folder]
    [--dry-run] [--show]

Options resolve files by checking absolute paths first, then data/inputs/<path> as a fallback.`);
}

function resolveInputFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const absolute = path.resolve(ROOT, filePath);
  if (fs.existsSync(absolute)) return absolute;
  const fallback = path.resolve(INPUT_ROOT, filePath);
  if (fs.existsSync(fallback)) return fallback;
  return absolute;
}

function ensureDir(dirPath, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function toRel(p) {
  return path.relative(CUSTOMIZATION_ROOT, p).split(path.sep).join('/');
}

function toPublicRel(p) {
  return path.relative(PUBLIC_ROOT, p).split(path.sep).join('/');
}

function readExistingMetadata() {
  if (!fs.existsSync(METADATA_PATH)) {
    return {
      organizationName: '',
      shortName: '',
      publicAssets: {},
      emailTemplates: [],
      notes: ''
    };
  }
  try {
    const raw = fs.readFileSync(METADATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      organizationName: parsed.organizationName || '',
      shortName: parsed.shortName || '',
      publicAssets: parsed.publicAssets || {},
      emailTemplates: Array.isArray(parsed.emailTemplates) ? parsed.emailTemplates : [],
      notes: parsed.notes || ''
    };
  } catch (err) {
    console.error(`❌ Unable to parse existing customization file (${METADATA_PATH}): ${err.message}`);
    process.exit(1);
  }
}

function copyFile(source, destination, dryRun) {
  if (dryRun) return;
  fs.copyFileSync(source, destination);
}

function copyDirectory(source, destination, dryRun) {
  if (dryRun) return;
  fs.cpSync(source, destination, { recursive: true });
}

function stagePublicAsset(options, metadata, optionKey, propKey, destFilename, allowedExts, dryRun) {
  const optionValue = options[optionKey];
  if (!optionValue) return;

  const resolved = resolveInputFile(optionValue);
  if (!fs.existsSync(resolved)) {
    console.error(`❌ Asset not found: ${optionValue}`);
    process.exit(1);
  }

  const ext = path.extname(resolved).toLowerCase();
  if (allowedExts && allowedExts.length > 0 && !allowedExts.includes(ext)) {
    console.error(`❌ Invalid extension for --${optionKey}. Allowed: ${allowedExts.join(', ')}`);
    process.exit(1);
  }

  ensureDir(PUBLIC_IMG_DIR, dryRun);
  const destination = path.join(PUBLIC_IMG_DIR, destFilename);
  console.log(`• ${destFilename} ← ${resolved}`);
  copyFile(resolved, destination, dryRun);
  metadata.publicAssets = metadata.publicAssets || {};
  metadata.publicAssets[propKey] = toPublicRel(destination);
}

function collectJsonFiles(dirPath) {
  const files = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      files.push(full);
    }
  }
  return files;
}

const { options } = parseArgs(process.argv.slice(2));

if (options.help) {
  usage();
  process.exit(0);
}

const dryRun = Boolean(options['dry-run']);
const showOnly = Boolean(options.show);

const actionableKeys = [
  'name',
  'short-name',
  'favicon',
  'logo-svg',
  'logo-png',
  'icon-192',
  'icon-512',
  'email-template',
  'email-templates'
];
const hasAction = actionableKeys.some(key => Object.prototype.hasOwnProperty.call(options, key));

if (!hasAction && !showOnly) {
  usage();
  console.log('\nProvide at least one option to set names, copy assets, or import email templates.');
  process.exit(1);
}

const metadata = readExistingMetadata();

if (showOnly) {
  console.log(JSON.stringify(metadata, null, 2));
  process.exit(0);
}

console.log(`ℹ️  Customizing application assets ${dryRun ? '(dry-run)' : ''}`);

if (options.name) {
  metadata.organizationName = options.name;
  console.log(`• organizationName → ${metadata.organizationName}`);
}

if (options['short-name']) {
  metadata.shortName = options['short-name'];
  console.log(`• shortName → ${metadata.shortName}`);
}

ensureDir(CUSTOMIZATION_ROOT, dryRun);

stagePublicAsset(options, metadata, 'favicon', 'favicon', 'favicon.ico', ['.ico'], dryRun);
stagePublicAsset(options, metadata, 'logo-svg', 'logoSvg', 'logo.svg', ['.svg'], dryRun);
stagePublicAsset(options, metadata, 'logo-png', 'logoPng', 'logo.png', ['.png'], dryRun);
stagePublicAsset(options, metadata, 'icon-192', 'icon192', 'icon-192.png', ['.png'], dryRun);
stagePublicAsset(options, metadata, 'icon-512', 'icon512', 'icon-512.png', ['.png'], dryRun);

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

const emailTemplates = normalizeArray(options['email-template']);
const emailDirectories = normalizeArray(options['email-templates']);
const emailEntries = [];

if (emailTemplates.length > 0) {
  ensureDir(EMAIL_DIR, dryRun);
  for (const template of emailTemplates) {
    const resolved = resolveInputFile(template);
    if (!fs.existsSync(resolved)) {
      console.error(`❌ Email template not found: ${template}`);
      process.exit(1);
    }
    if (path.extname(resolved).toLowerCase() !== '.json') {
      console.error('❌ Email templates must be JSON files.');
      process.exit(1);
    }
    const destination = path.join(EMAIL_DIR, path.basename(resolved));
    console.log(`• email template ← ${resolved}`);
    copyFile(resolved, destination, dryRun);
    emailEntries.push(toRel(destination));
  }
}

if (emailDirectories.length > 0) {
  ensureDir(EMAIL_DIR, dryRun);
  for (const directory of emailDirectories) {
    const resolvedDir = resolveInputFile(directory);
    if (!fs.existsSync(resolvedDir) || !fs.lstatSync(resolvedDir).isDirectory()) {
      console.error(`❌ Email templates directory not found: ${directory}`);
      process.exit(1);
    }
    const destDir = path.join(EMAIL_DIR, path.basename(resolvedDir));
    console.log(`• email templates dir ← ${resolvedDir}`);
    copyDirectory(resolvedDir, destDir, dryRun);
    const copiedFiles = dryRun ? collectJsonFiles(resolvedDir)
      .map(file => file.replace(resolvedDir, destDir)) : collectJsonFiles(destDir);
    emailEntries.push(...copiedFiles.map(toRel));
  }
}

if (emailEntries.length > 0) {
  const existing = Array.isArray(metadata.emailTemplates) ? metadata.emailTemplates : [];
  const merged = [...existing, ...emailEntries];
  metadata.emailTemplates = Array.from(new Set(merged)).sort();
}

if (dryRun) {
  console.log('✓ Dry run complete — no files written.');
  process.exit(0);
}

fs.mkdirSync(CUSTOMIZATION_ROOT, { recursive: true });
metadata.notes = 'Generated by scripts/00-system-management/customize-app.js';
fs.writeFileSync(METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
console.log(`✓ Customization configuration saved to ${METADATA_PATH}`);
