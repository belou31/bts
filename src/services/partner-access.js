// src/services/partner-access.js
//
// Qui peut entrer sur les pages et l'API d'un partenaire.
//
// Deux régimes, choisis partenaire par partenaire :
//   - jeton statique (défaut) : `?token=` ou en-tête x-partner-token ;
//   - connexion OpenID obligatoire (`oidc.required: true`) : seule une session
//     ouverte par /partner/<slug>/auth/callback donne accès. Le jeton statique
//     n'y suffit plus — sinon l'obligation se contournerait en le recopiant.
import { oidcConfigFor } from './partner-oidc.js';
import { readSession } from './partner-session.js';

export function expectedPartnerToken(cfg, eventSlug) {
  if (!cfg) return null;
  if (cfg.tokens?.events && eventSlug && cfg.tokens.events[eventSlug]) {
    return cfg.tokens.events[eventSlug];
  }
  return cfg.accessToken || null;
}

export function isOidcRequired(cfg) {
  return oidcConfigFor(cfg)?.required === true;
}

/**
 * { ok: true, session? } ou { ok: false, reason: 'login_required' | 'token_invalid' }.
 * `eventSlug` sert au seul régime à jeton (jetons par événement).
 */
export function checkPartnerAccess(req, cfg, eventSlug = null) {
  if (isOidcRequired(cfg)) {
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
