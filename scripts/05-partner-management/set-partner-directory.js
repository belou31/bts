#!/usr/bin/env node
/**
 * Active ou désactive la connexion par annuaire local d'un partenaire
 * (partenaires sans fournisseur d'identité OpenID).
 *
 * Usage:
 *   node scripts/05-partner-management/set-partner-directory.js --partner=<slug> --enabled=yes|no [--dry-run]
 *
 * Effet : écrit `"directory": { "enabled": true|false }` dans l'entrée du
 * partenaire de data/customization/partners.json, sans toucher au reste.
 * Activé, la connexion devient obligatoire sur les pages du partenaire :
 * identifiant + e-mail de l'annuaire, puis code reçu par e-mail. L'annuaire
 * s'importe sur /partner/<slug>/admin/directory.
 *
 * Refuse l'activation pour un partenaire qui a un bloc `oidc` : un
 * partenaire n'a qu'un mode de connexion.
 */
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : null;
};
const slug = String(opt('partner') || '').toLowerCase();
const enabledRaw = String(opt('enabled') || '').toLowerCase();
const dryRun = args.includes('--dry-run');

if (!slug || !['yes', 'no', 'true', 'false', '1', '0'].includes(enabledRaw)) {
  console.error('Usage: node scripts/05-partner-management/set-partner-directory.js --partner=<slug> --enabled=yes|no [--dry-run]');
  process.exit(1);
}
const enabled = ['yes', 'true', '1'].includes(enabledRaw);

const file = path.resolve(process.cwd(), 'data', 'customization', 'partners.json');
let entries;
try {
  entries = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`❌ Lecture impossible de ${file} : ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(entries)) {
  console.error(`❌ ${file} : un tableau de partenaires est attendu`);
  process.exit(1);
}
const partner = entries.find(e => String(e?.slug || '').toLowerCase() === slug);
if (!partner) {
  console.error(`❌ Partenaire « ${slug} » introuvable dans partners.json`);
  process.exit(1);
}
if (enabled && partner.oidc) {
  console.error(`❌ « ${slug} » a déjà un bloc oidc : un partenaire n'a qu'un mode de connexion. Retirez le bloc oidc pour utiliser l'annuaire.`);
  process.exit(1);
}

const before = partner.directory?.enabled === true;
partner.directory = { ...(partner.directory || {}), enabled };
console.log(`• ${slug} : connexion par annuaire ${before ? 'activée' : 'désactivée'} → ${enabled ? 'activée' : 'désactivée'}`);
if (enabled && !partner.admin?.user) {
  console.warn(`⚠ « ${slug} » n'a pas de bloc admin (user/pass) : la page /partner/${slug}/admin/directory, qui sert à importer l'annuaire, restera fermée.`);
}

if (dryRun) {
  console.log('✓ Dry-run : partners.json non modifié.');
  process.exit(0);
}
fs.writeFileSync(file, JSON.stringify(entries, null, 2) + '\n', 'utf8');
console.log(`✓ ${file} mis à jour`);
