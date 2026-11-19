// src/services/payments/http.js
//
// Les deux gestes que tout appel à un prestataire de paiement doit faire, et
// qu'aucun adaptateur ne faisait : BORNER L'ATTENTE et NE PAS REDEMANDER UN
// JETON À CHAQUE FOIS.
//
// CE QUI MANQUAIT. `fetch` de Node n'a pas de délai de garde utile : une
// connexion qui reste ouverte sans répondre bloque l'appel pendant des
// minutes. Le serveur étant mono-processus, cet appel suspendu retient aussi
// la boucle d'évènements pour tout le monde. Et comme la commande est créée
// AVANT l'appel, chaque appel suspendu laissait une commande impayable tenant
// ses places. C'est le mécanisme des 374 commandes « mort-nées » du match du
// 03/10/2026.
//
// Côté jeton, HelloAsso demandait un `client_credentials` neuf à chaque
// création d'intent, chaque sondage de statut, chaque page de retour et chaque
// passage de la sentinelle : deux appels réseau là où un seul était utile, sur
// le point de terminaison que les prestataires limitent le plus sévèrement.
//
// PORTÉE. Ce module ne sait rien d'un prestataire en particulier : il ne fait
// que le transport. Les adaptateurs gardent leurs charges utiles et leurs
// statuts.

/** Délai de garde par défaut, en millisecondes. */
function defaultTimeoutMs() {
  const raw = Number(process.env.PAYMENT_HTTP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

/**
 * Appelle un prestataire en bornant l'attente.
 *
 * `retry` est EXPLICITE et faux par défaut, parce que réessayer n'est pas
 * anodin : rejouer la création d'un intent peut ouvrir un second paiement chez
 * le prestataire. Seuls les appels dont la répétition est sans conséquence —
 * une lecture, la frappe d'un jeton — le demandent.
 *
 * @param {string} url
 * @param {object} init                 passé tel quel à fetch (method, headers, body…)
 * @param {object} opts
 * @param {string} opts.label           préfixe de journal, ex. 'helloasso oauth'
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.retry=false]  une seconde tentative si la première n'a rien ramené
 * @returns {Promise<{res: Response, json: object}>}
 */
export async function providerFetch(url, init = {}, { label = 'provider', timeoutMs, retry = false } = {}) {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs();
  const attempts = retry ? 2 : 1;
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(budget) });
      // Une réponse reçue, même en erreur, est une réponse : c'est à
      // l'adaptateur de décider si 409 ou 422 se rejoue, pas à nous.
      const json = await res.json().catch(() => ({}));
      return { res, json };
    } catch (err) {
      lastErr = err;
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      console.warn(`[${label}] ${timedOut ? `timeout after ${budget}ms` : 'network error'}:`, err?.message || err);
      if (i + 1 < attempts) continue;
    }
  }
  throw new Error(`${label} unreachable: ${lastErr?.message || lastErr}`);
}

/**
 * Cache de jeton d'accès, par prestataire.
 *
 * Un jeton `client_credentials` vaut typiquement une demi-heure ; le
 * redemander à chaque appel double le trafic sans rien apporter. On garde donc
 * le jeton jusqu'à peu avant son échéance — `skewMs` couvre l'horloge et le
 * temps de vol — et on sait l'oublier : un 401 doit pouvoir forcer un jeton
 * neuf, sans quoi un secret tourné côté prestataire fige le processus jusqu'au
 * redémarrage.
 *
 * Le cache vit dans le processus. Avec plusieurs instances chacune a le sien,
 * ce qui est correct : un jeton n'est pas une ressource partagée.
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {number} [opts.skewMs=60000]
 * @returns {{get: (mint: () => Promise<{token: string, expiresInSec?: number}>) => Promise<string>, invalidate: () => void}}
 */
export function createTokenCache({ label, skewMs = 60_000 } = {}) {
  let token = null;
  let expiresAt = 0;
  // Deux requêtes simultanées qui trouvent le cache vide ne doivent pas
  // frapper deux jetons : la seconde attend la frappe en cours.
  let inFlight = null;

  return {
    async get(mint) {
      const now = Date.now();
      if (token && now < expiresAt) return token;
      if (inFlight) return inFlight;

      inFlight = (async () => {
        try {
          const { token: fresh, expiresInSec } = await mint();
          if (!fresh) throw new Error(`${label}: provider returned no access token`);
          const ttlSec = Number(expiresInSec);
          // Sans `expires_in`, on reste prudent : un quart d'heure, soit bien
          // moins que la durée habituelle, plutôt que de supposer.
          const lifeMs = Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec * 1000 : 15 * 60 * 1000;
          token = fresh;
          expiresAt = Date.now() + Math.max(0, lifeMs - skewMs);
          return token;
        } finally {
          inFlight = null;
        }
      })();

      return inFlight;
    },
    invalidate() {
      token = null;
      expiresAt = 0;
    }
  };
}
