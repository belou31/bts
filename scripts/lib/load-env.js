// scripts/lib/load-env.js
//
// Charge l'environnement EXACTEMENT comme src/server.js.
//
// L'application lit `.env`, PUIS `.env.<PAYMENT_PROVIDER>` — c'est là que
// vivent les identifiants du prestataire (.env.sumup, .env.helloasso). Un
// script qui se contente de `dotenv.config()` ne voit donc aucune de ces
// variables et conclut à tort qu'elles ne sont pas définies.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * @returns {{files: string[], provider: string|null}} ce qui a été chargé,
 *   pour que l'appelant puisse le dire à l'opérateur plutôt que de le taire.
 */
export function loadEnv() {
  const loaded = [];
  const base = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(base)) {
    dotenv.config({ path: base });
    loaded.push('.env');
  }

  // Même ordre que server.js : le fichier du prestataire ne remplace pas une
  // variable déjà posée par `.env` ou par l'environnement système.
  const provider = (process.env.PAYMENT_PROVIDER || '').trim();
  if (provider) {
    const file = path.resolve(process.cwd(), `.env.${provider}`);
    if (fs.existsSync(file)) {
      dotenv.config({ path: file });
      loaded.push(`.env.${provider}`);
    }
  }
  return { files: loaded, provider: provider || null };
}
