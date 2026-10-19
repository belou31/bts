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

// { tx } ou { reason: 'missing' | 'expired' | 'invalid' } : le motif sert le
// message d'erreur, chaque cas appelant une correction différente.
function readTxCookie(req) {
  const raw = String(req.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1 || part.slice(0, i).trim() !== TX_COOKIE) continue;
    try { return { tx: jwt.verify(decodeURIComponent(part.slice(i + 1).trim()), secret()) }; }
    catch (err) { return { reason: err?.name === 'TokenExpiredError' ? 'expired' : 'invalid' }; }
  }
  return { reason: 'missing' };
}

// Pourquoi la demande de connexion est introuvable, en clair. Cookie absent
// et hôte différent d'APP_URL : la connexion a commencé sur une autre adresse
// (127.0.0.1 au lieu de localhost, IP de réseau…), le cookie y est resté.
function txProblem(req, reason) {
  if (reason === 'expired') {
    return 'Demande de connexion expirée (plus de 10 minutes sur l\'écran de connexion). Relancer la connexion.';
  }
  if (reason === 'invalid') {
    return 'Demande de connexion illisible (JWT_SECRET changé, ou serveur redémarré avec un autre secret). Relancer la connexion.';
  }
  let expectedHost = '';
  try { expectedHost = new URL(appBase()).host; } catch { /* APP_URL vide */ }
  const currentHost = String(req.get?.('host') || '');
  if (expectedHost && currentHost && expectedHost !== currentHost) {
    return `Demande de connexion introuvable : ce retour arrive sur ${currentHost}, mais BTS attend ${expectedHost} `
      + `(APP_URL). Ouvrir BTS à l'adresse ${appBase()} puis relancer la connexion.`;
  }
  return 'Demande de connexion introuvable : le cookie de connexion n\'a pas été renvoyé par le navigateur. '
    + `Vérifier que la connexion a été lancée depuis ${appBase() || 'l\'adresse d\'APP_URL'} (même nom d'hôte, `
    + 'pas 127.0.0.1 à la place de localhost) et que les cookies ne sont pas bloqués, puis relancer la connexion.';
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

  // Le retour de l'IdP arrive sur l'hôte d'APP_URL : le cookie de transaction
  // doit y être posé. Une connexion lancée sur un autre nom (127.0.0.1 au lieu
  // de localhost…) y est d'abord renvoyée. Une seule fois (_h=1) : derrière un
  // mandataire qui ne transmet pas l'en-tête Host, on ne boucle pas, le
  // callback expliquera le problème.
  let appOrigin = '';
  try { appOrigin = new URL(appBase()).origin; } catch { /* APP_URL vide */ }
  const appHost = appOrigin ? new URL(appOrigin).host : '';
  if (appHost && req.get('host') && req.get('host') !== appHost && req.query._h !== '1') {
    const sep = req.originalUrl.includes('?') ? '&' : '?';
    return res.redirect(`${appOrigin}${req.originalUrl}${sep}_h=1`);
  }

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

  const { tx, reason } = readTxCookie(req);
  res.clearCookie(TX_COOKIE, { path: '/' });
  if (!tx) return res.status(400).send(txProblem(req, reason));
  if (tx.slug !== slug) {
    return res.status(400).send(`Demande de connexion ouverte pour le partenaire « ${tx.slug} », pas « ${slug} ». Relancer la connexion.`);
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
    identifier: session.sub, email: session.email || null, name: session.name || null,
    firstName: session.firstName || null, lastName: session.lastName || null,
    via: session.via || 'oidc', expiresAt: new Date(session.exp * 1000).toISOString(),
    attributes: session.attributes || {}
  });
});

export default router;
