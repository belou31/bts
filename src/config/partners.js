// src/config/partners.js
//
// Configuration des partenaires : un fichier par partenaire,
//
//   data/customization/partners/<slug>/partner.json
//
// à côté de ses textes (partners/<slug>.json, partners/<slug>/seasons|events/).
// Le nom du dossier fait le slug. Un fichier illisible n'écarte que son
// partenaire, avec un avertissement — plus tout l'ensemble comme l'ancien
// tableau unique.
//
// Transition : l'ancien data/customization/partners.json (tableau) est encore
// lu pour les partenaires qui n'ont pas leur fichier ; chaque écriture
// (writePartnerConfig) déplace le partenaire dans son fichier.
// Migration en bloc : scripts/05-partner-management/migrate-partners-to-files.js.

import fs from 'fs';
import path from 'path';

export const PARTNER_FILE = 'partner.json';

export function partnersDir() {
  return path.resolve(process.cwd(), 'data', 'customization', 'partners');
}

export function legacyPartnersFile() {
  return path.resolve(process.cwd(), 'data', 'customization', 'partners.json');
}

export function normalizeSlug(slug) {
  return String(slug || '').trim().toLowerCase();
}

export function partnerConfigPath(slug) {
  return path.join(partnersDir(), normalizeSlug(slug), PARTNER_FILE);
}

// Un avertissement par fichier et par contenu, pas à chaque requête.
const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Partenaires de l'ancien tableau, ou [] (absent, illisible). */
export function readLegacyPartners() {
  const file = legacyPartnersFile();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = readJson(file);
    return Array.isArray(parsed) ? parsed.filter(p => p?.slug) : [];
  } catch (err) {
    warnOnce(`legacy:${fs.statSync(file).mtimeMs}`, `[partners] ${file} illisible : ${err.message}`);
    return [];
  }
}

/** Slugs ayant un dossier avec partner.json (les dossiers « _… » sont réservés). */
export function listPartnerFileSlugs() {
  const dir = partnersDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && fs.existsSync(path.join(dir, d.name, PARTNER_FILE)))
    .map(d => d.name)
    .sort();
}

function loadPartnerFile(slug) {
  const file = path.join(partnersDir(), slug, PARTNER_FILE);
  try {
    const cfg = readJson(file);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('un objet JSON est attendu');
    if (cfg.slug && normalizeSlug(cfg.slug) !== normalizeSlug(slug)) {
      warnOnce(`slug:${file}:${cfg.slug}`, `[partners] ${file} : « slug » (${cfg.slug}) diffère du dossier ; le dossier fait foi (${slug}).`);
    }
    return { ...cfg, slug: normalizeSlug(slug) };
  } catch (err) {
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* supprimé entre-temps */ }
    warnOnce(`file:${file}:${mtime}`, `[partners] ${file} illisible, partenaire « ${slug} » ignoré : ${err.message}`);
    return null;
  }
}

function getMergedConfigs() {
  const fromFiles = listPartnerFileSlugs().map(loadPartnerFile).filter(Boolean);
  const seen = new Set(listPartnerFileSlugs());
  const legacy = readLegacyPartners()
    .map(p => ({ ...p, slug: normalizeSlug(p.slug) }))
    .filter(p => !seen.has(p.slug));
  return [...fromFiles, ...legacy];
}

/**
 * Pour les scripts : { cfg, file, legacy } — `legacy` vrai si la
 * configuration vient encore de l'ancien partners.json ; cfg null si inconnu.
 * Un fichier illisible lève une erreur : un script ne doit pas l'écraser.
 */
export function readPartnerConfig(slug) {
  const key = normalizeSlug(slug);
  const file = partnerConfigPath(key);
  if (fs.existsSync(file)) {
    const cfg = readJson(file);
    return { cfg: { ...cfg, slug: key }, file, legacy: false };
  }
  const old = readLegacyPartners().find(p => normalizeSlug(p.slug) === key);
  return { cfg: old ? { ...old, slug: key } : null, file, legacy: Boolean(old) };
}

/**
 * Écrit partners/<slug>/partner.json (fichier temporaire puis renommage : un
 * lecteur ne voit jamais un fichier à moitié écrit), puis retire le
 * partenaire de l'ancien partners.json s'il y était encore.
 */
export function writePartnerConfig(slug, cfg) {
  const key = normalizeSlug(slug);
  if (!key || key.startsWith('_') || !/^[a-z0-9][a-z0-9_-]*$/.test(key)) throw new Error(`slug invalide : « ${slug} »`);
  const file = partnerConfigPath(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { slug: _drop, ...rest } = cfg || {};
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ slug: key, ...rest }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);

  const legacyFile = legacyPartnersFile();
  if (fs.existsSync(legacyFile)) {
    let list = null;
    try { list = readJson(legacyFile); } catch { /* illisible : on n'y touche pas */ }
    if (Array.isArray(list) && list.some(p => normalizeSlug(p?.slug) === key)) {
      const rest2 = list.filter(p => normalizeSlug(p?.slug) !== key);
      fs.writeFileSync(legacyFile, JSON.stringify(rest2, null, 2) + '\n', 'utf8');
    }
  }
  return file;
}

// ── Modèles par mode de connexion ───────────────────────────────────────────
//
// Copiés une fois à la création d'un partenaire (upsert-partner --template),
// jamais hérités ensuite : le fichier du partenaire contient tout ce qui
// s'applique. Modèle local data/customization/partners/_templates/<kind>.json
// (créé par init-partners.js, modifiable) s'il existe, sinon celui livré dans
// data_references/partners/<kind>.json.

export const PARTNER_TEMPLATES = ['openid', 'directory', 'none'];

export function builtinTemplatePath(kind) {
  return path.resolve(process.cwd(), 'data_references', 'partners', `${kind}.json`);
}

export function localTemplatePath(kind) {
  return path.join(partnersDir(), '_templates', `${kind}.json`);
}

/** { cfg, notes, source } — `cfg` sans les clés « _… » (notes du modèle). */
export function loadPartnerTemplate(kind) {
  if (!PARTNER_TEMPLATES.includes(kind)) {
    throw new Error(`modèle inconnu « ${kind} » (attendu : ${PARTNER_TEMPLATES.join(', ')})`);
  }
  const source = fs.existsSync(localTemplatePath(kind)) ? localTemplatePath(kind) : builtinTemplatePath(kind);
  const raw = readJson(source);
  const notes = Array.isArray(raw._notes) ? raw._notes : [];
  const cfg = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
  return { cfg, notes, source };
}

export function getPartnerConfig(slug) {
  if (!slug) return null;
  const key = String(slug).trim().toLowerCase();
  const configs = getMergedConfigs();
  const base = configs.find(cfg => cfg.slug === key);
  if (!base) return null;
  return base;
}

/**
 * Mode de paiement d'un partenaire : « psp » (paiement en ligne) par défaut,
 * comme le créent upsert-partner / import-partners. Seule une valeur
 * explicite autre (« invoice_auto »…) bascule en demande facturée.
 */
export function partnerPaymentMode(cfg) {
  const mode = String(cfg?.paymentMode || '').trim();
  return mode || 'psp';
}

export function isInvoicePartner(cfg) {
  return partnerPaymentMode(cfg) !== 'psp';
}

export function listPartnerConfigs() {
  return getMergedConfigs();
}
