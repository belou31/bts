// src/routes/partner-auth.routes.js
//
// Parcours OIDC d'un partenaire : /partner/:slug/auth/{login,callback,logout}.
//
// Optionnel par construction : ces routes ne répondent que pour un partenaire
// dont la configuration porte un bloc `oidc`. Les autres gardent le jeton
// statique et l'iframe, inchangés.
import { Router } from 'express';
import jwt from 'jsonwebtoken';

import { getPartnerConfig } from '../config/partners.js';
import {
  oidcConfigFor, buildAuthorizeUrl, exchangeCode,
  identityFromClaims, createPkce, randomToken
} from '../services/partner-oidc.js';
import { issueSession, clearSession, readSession } from '../services/partner-session.js';

const router = Router();

// L'état de la transaction (state, nonce, vérificateur PKCE, destination) est
// porté par un cookie signé et éphémère, non par la mémoire du processus :
// deux instances derrière un répartiteur de charge doivent pouvoir se relayer.
const TX_COOKIE = 'bts_oidc_tx';
const TX_TTL_SECONDS = 10 * 60;

function appBase() {
  return String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
}

function redirectUriFor(slug) {
  return `${appBase()}/partner/${encodeURIComponent(slug)}/auth/callback`;
}

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET requis pour l\'authentification partenaire');
  return s;
}

function readTxCookie(req) {
  const raw = String(req.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1 || part.slice(0, i).trim() !== TX_COOKIE) continue;
    try { return jwt.verify(decodeURIComponent(part.slice(i + 1).trim()), secret()); }
    catch { return null; }
  }
  return null;
}

/**
 * Destination après connexion. Jamais prise telle quelle : une URL fournie par
 * l'appelant et suivie sans contrôle est une redirection ouverte, dont on se
 * sert pour faire atterrir quelqu'un ailleurs sous notre domaine. Seul un
 * chemin interne au partenaire concerné est accepté.
 */
function safeNext(slug, raw) {
  const fallback = `/partner/${encodeURIComponent(slug)}/events`;
  const value = String(raw || '').trim();
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//')) return fallback;          // //evil.example = absolu
  const expected = `/partner/${encodeURIComponent(slug)}/`;
  return value.startsWith(expected) ? value : fallback;
}

function resolvePartner(req, res) {
  const slug = String(req.params.partnerSlug || '').trim().toLowerCase();
  const cfg = slug ? getPartnerConfig(slug) : null;
  if (!cfg) {
    res.status(404).send('Partner not found');
    return null;
  }
  const oidc = oidcConfigFor(cfg);
  if (!oidc) {
    // Dire que ce partenaire n'est pas configuré pour OIDC, plutôt qu'un 404
    // qui laisserait croire à une faute de frappe.
    res.status(404).send('Ce partenaire n\'utilise pas l\'authentification OpenID.');
    return null;
  }
  return { slug, cfg, oidc };
}

router.get('/partner/:partnerSlug/auth/login', async (req, res) => {
  const ctx = resolvePartner(req, res);
  if (!ctx) return;
  const { slug, oidc } = ctx;

  try {
    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = createPkce();
    const next = safeNext(slug, req.query.next);

    const tx = jwt.sign({ slug, state, nonce, verifier, next }, secret(), { expiresIn: TX_TTL_SECONDS });
    res.cookie(TX_COOKIE, tx, {
      httpOnly: true,
      sameSite: 'lax',           // le retour de l'IdP est une navigation tierce
      secure: appBase().startsWith('https://'),
      maxAge: TX_TTL_SECONDS * 1000,
      path: '/'
    });

    const url = await buildAuthorizeUrl({
      oidc, redirectUri: redirectUriFor(slug), state, nonce, challenge
    });
    return res.redirect(url);
  } catch (err) {
    console.error('[partner-auth/login]', err);
    return res.status(502).send(`Connexion impossible auprès du fournisseur d'identité : ${err.message}`);
  }
});

router.get('/partner/:partnerSlug/auth/callback', async (req, res) => {
  const ctx = resolvePartner(req, res);
  if (!ctx) return;
  const { slug, oidc } = ctx;

  // L'IdP peut refuser : le dire tel quel plutôt que de laisser une page vide.
  if (req.query.error) {
    const detail = String(req.query.error_description || req.query.error);
    return res.status(403).send(`Authentification refusée par le fournisseur d'identité : ${detail}`);
  }

  const tx = readTxCookie(req);
  res.clearCookie(TX_COOKIE, { path: '/' });
  if (!tx || tx.slug !== slug) {
    return res.status(400).send('Demande d\'authentification inconnue ou expirée. Relancer la connexion.');
  }
  const state = String(req.query.state || '');
  if (!state || state !== tx.state) {
    // Un retour dont le state ne correspond pas n'est pas le nôtre.
    return res.status(400).send('Paramètre « state » invalide : demande rejetée.');
  }
  const code = String(req.query.code || '').trim();
  if (!code) return res.status(400).send('Code d\'autorisation absent.');

  try {
    const { claims } = await exchangeCode({
      oidc, redirectUri: redirectUriFor(slug), code, verifier: tx.verifier, nonce: tx.nonce
    });
    const identity = identityFromClaims(oidc, claims);
    issueSession(res, { slug, identity, via: 'oidc' });
    return res.redirect(`${appBase()}${tx.next}`);
  } catch (err) {
    if (err?.code === 'claim_mismatch') {
      return res.status(403).send(err.message);
    }
    console.error('[partner-auth/callback]', err);
    return res.status(502).send(`Échec de l'authentification : ${err.message}`);
  }
});

router.get('/partner/:partnerSlug/auth/logout', (req, res) => {
  const slug = String(req.params.partnerSlug || '').trim().toLowerCase();
  clearSession(res, slug);
  return res.redirect(`${appBase()}/partner/${encodeURIComponent(slug)}/events`);
});

/** Qui est connecté — utile pour vérifier une intégration sans deviner. */
router.get('/partner/:partnerSlug/auth/whoami', (req, res) => {
  const slug = String(req.params.partnerSlug || '').trim().toLowerCase();
  const session = readSession(req, slug);
  if (!session) return res.status(401).json({ ok: false, authenticated: false });
  return res.json({
    ok: true, authenticated: true, slug,
    subject: session.sub, email: session.email || null, name: session.name || null,
    via: session.via || 'oidc', expiresAt: new Date(session.exp * 1000).toISOString()
  });
});

export default router;
