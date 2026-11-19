// src/services/partner-access.js
//
// Qui peut entrer sur les pages et l'API d'un partenaire.
//
// Selon le mode de connexion du partenaire (services/partner-connection.js) :
//   - "none" : jeton statique s'il y en a un (`?token=` ou en-tête
//     x-partner-token), sinon accès libre ;
//   - "openid" ou "directory" : connexion obligatoire. Seule une session ouverte
//     par /partner/<slug>/auth/… donne accès. Le jeton statique n'y suffit plus
//     — sinon l'obligation se contournerait en le recopiant.
import { readSession } from './partner-session.js';
import { partnerConnection } from './partner-connection.js';

export function expectedPartnerToken(cfg, eventSlug) {
  if (!cfg) return null;
  if (cfg.tokens?.events && eventSlug && cfg.tokens.events[eventSlug]) {
    return cfg.tokens.events[eventSlug];
  }
  return cfg.accessToken || null;
}

/** Connexion obligatoire : mode "openid" ou "directory". */
export function isLoginRequired(cfg) {
  return partnerConnection(cfg) !== 'none';
}

/**
 * { ok: true, session? } ou { ok: false, reason: 'login_required' | 'token_invalid' }.
 * `eventSlug` sert au seul régime à jeton (jetons par événement).
 */
export function checkPartnerAccess(req, cfg, eventSlug = null) {
  if (isLoginRequired(cfg)) {
    const session = readSession(req, cfg.slug || req.params?.partnerSlug);
    return session ? { ok: true, session } : { ok: false, reason: 'login_required' };
  }
  const expected = expectedPartnerToken(cfg, eventSlug);
  if (!expected) return { ok: true };
  const provided = String(req.query?.token || req.get?.('x-partner-token') || '').trim();
  return provided && provided === expected ? { ok: true } : { ok: false, reason: 'token_invalid' };
}

/**
 * Adresse de connexion qui ramène ensuite sur la page demandée. `req.url` est
 * relatif au point de montage (BASE_PATH exclu), ce qu'attend `next` côté
 * callback.
 */
export function partnerLoginPath(basePath, slug, req) {
  const base = String(basePath || '').replace(/\/+$/, '');
  return `${base}/partner/${encodeURIComponent(slug)}/auth/login?next=${encodeURIComponent(req.url)}`;
}
