#!/usr/bin/env node
/**
 * Choisit le mode de connexion des ayants droit d'un partenaire.
 *
 * Usage:
 *   node scripts/05-partner-management/set-partner-connection.js --partner=<slug> --mode=openid|directory|none [--dry-run]
 *
 *   openid     connexion obligatoire via le fournisseur d'identité du partenaire
 *              (bloc `oidc` requis : issuer, clientId…) ;
 *   directory  connexion obligatoire via l'annuaire BTS (identifiant + e-mail +
 *              code), importé sur /partner/<slug>/admin/directory ;
 *   none       pas de connexion : pages ouvertes, ou protégées par le jeton
 *              statique (Generate Partner Token).
 *
 * Effet : écrit `"connection": "<mode>"` dans l'entrée du partenaire de
 * data/customization/partners.json et retire les anciens interrupteurs
 * (oidc.required, directory.enabled), pour qu'un seul réglage fasse foi. Les
 * blocs oidc / directory restent en place : changer de mode ne perd ni les
 * secrets du fournisseur d'identité ni les réglages de l'annuaire. Le reste de
 * l'entrée n'est pas touché. Voir src/services/partner-connection.js.
 */
import fs from 'fs';
import path from 'path';
import { CONNECTION_MODES, partnerConnection } from '../../src/services/partner-connection.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : null;
};
const slug = String(opt('partner') || '').toLowerCase();
const mode = String(opt('mode') || '').toLowerCase();
const dryRun = args.includes('--dry-run');

if (!slug || !CONNECTION_MODES.includes(mode)) {
  console.error(`Usage: node scripts/05-partner-management/set-partner-connection.js --partner=<slug> --mode=${CONNECTION_MODES.join('|')} [--dry-run]`);
  process.exit(1);
}

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
if (mode === 'openid' && !(partner.oidc?.issuer && partner.oidc?.clientId)) {
  console.error(`❌ « ${slug} » n'a pas de bloc oidc complet (issuer, clientId) : configurez-le dans partners.json avant de choisir openid.`);
  process.exit(1);
}

const before = partnerConnection(partner);
partner.connection = mode;
// Un seul interrupteur : les anciens sont retirés, les blocs de réglages gardés.
if (partner.oidc && 'required' in partner.oidc) delete partner.oidc.required;
if (partner.directory && 'enabled' in partner.directory) delete partner.directory.enabled;
if (partner.directory && !Object.keys(partner.directory).length) delete partner.directory;

console.log(`• ${slug} : connexion ${before} → ${mode}`);
if (mode !== 'none' && (partner.accessToken || Object.keys(partner.tokens?.seasons || {}).length || Object.keys(partner.tokens?.events || {}).length)) {
  console.log('  ℹ le jeton statique n\'ouvrira plus les pages : la connexion devient obligatoire.');
}
if (mode === 'directory' && !partner.admin?.user) {
  console.warn(`⚠ « ${slug} » n'a pas d'identifiants admin (Set Partner Admin Credentials) : la page /partner/${slug}/admin/directory, qui sert à importer l'annuaire, restera fermée.`);
}

if (dryRun) {
  console.log('✓ Dry-run : partners.json non modifié.');
  process.exit(0);
}
fs.writeFileSync(file, JSON.stringify(entries, null, 2) + '\n', 'utf8');
console.log(`✓ ${file} mis à jour`);
