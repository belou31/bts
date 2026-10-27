// src/services/partner-connection.js
//
// Mode de connexion des ayants droit d'un partenaire : UN interrupteur,
// `connection` dans partners.json (script set-partner-connection.js).
//
//   "openid"     connexion obligatoire via le fournisseur d'identité du
//                partenaire (bloc `oidc`, services/partner-oidc.js) ;
//   "directory"  connexion obligatoire via l'annuaire tenu par BTS (bloc
//                `directory`, services/partner-directory.js) ;
//   "none"       pas de connexion : pages ouvertes, ou protégées par le jeton
//                statique s'il y en a un.
//
// Les blocs `oidc` et `directory` ne sont que des RÉGLAGES : on peut changer
// de mode sans perdre les secrets du fournisseur d'identité.
//
// Sans `connection` (configurations antérieures), le mode se déduit des
// anciens interrupteurs : directory.enabled → "directory", oidc.required →
// "openid", sinon "none".

export const CONNECTION_MODES = ['openid', 'directory', 'none'];

export function partnerConnection(cfg) {
  const explicit = String(cfg?.connection || '').trim().toLowerCase();
  if (CONNECTION_MODES.includes(explicit)) return explicit;
  if (cfg?.directory?.enabled === true) return 'directory';
  if (cfg?.oidc?.required === true) return 'openid';
  return 'none';
}
