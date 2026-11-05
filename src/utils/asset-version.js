// src/utils/asset-version.js
// Empreinte du contenu de public/static, calculée au démarrage du serveur.
//
// Les vues l'ajoutent aux adresses des scripts et feuilles de style
// (`?v=<empreinte>`). /static est servi avec un cache navigateur d'une heure
// et des adresses fixes : sans version, un visiteur revenu dans l'heure qui
// suit un déploiement recevait la nouvelle page avec l'ancien script (plan
// absent, par exemple). Une empreinte de contenu, et non une date de
// démarrage, donne la même valeur à toutes les instances pm2 et ne change
// que si un fichier change.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function computeAssetVersion(dir) {
  const hash = crypto.createHash('sha1');
  try {
    for (const file of listFiles(dir).sort()) {
      hash.update(path.relative(dir, file));
      hash.update('\0');
      hash.update(fs.readFileSync(file));
      hash.update('\0');
    }
  } catch (err) {
    // Dossier illisible : une valeur propre à ce démarrage plutôt que rien.
    console.warn('[asset-version] empreinte impossible, repli sur la date :', err.message);
    return Date.now().toString(36);
  }
  return hash.digest('hex').slice(0, 10);
}

// Ajoute la version à une adresse, en respectant une éventuelle query existante.
export function withAssetVersion(url, version) {
  if (!url || !version) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}`;
}
