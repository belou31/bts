// src/routes/dev-oidc-stub.routes.js
//
// Fournisseur d'identité FACTICE, conforme au strict nécessaire d'OpenID
// Connect, pour éprouver le parcours partenaire sans dépendre d'un tiers.
//
// Il implémente ce que la norme exige du côté serveur : découverte, endpoint
// d'autorisation, échange de code avec PKCE, id_token signé RS256, JWKS,
// userinfo. Assez pour que le client côté BTS soit exercé comme il le sera
// face à un vrai IdP — et pour que l'on constate un refus quand un contrôle
// échoue, au lieu de le supposer.
//
// ⚠️ NE JAMAIS ACTIVER EN PRODUCTION. Il délivre une identité à quiconque la
// demande. Monté uniquement si OIDC_STUB=true, et il refuse de démarrer si
// APP_ENV vaut production.
import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const router = Router();

// Clé de signature engendrée au démarrage : rien à stocker, et une clé qui ne
// survit pas au redémarrage ne peut pas se retrouver en production par
// inadvertance.
// Engendrée à la PREMIÈRE requête, pas au chargement : le module est importé
// statiquement (le routeur parent n'est pas asynchrone), et la production n'a
// pas à payer une génération de clé pour un service qu'elle ne monte pas.
let KEYS = null;
function keys() {
  if (KEYS) return KEYS;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'stub-' + crypto.randomBytes(4).toString('hex');
  KEYS = {
    kid,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }
  };
  return KEYS;
}

// Codes d'autorisation en mémoire, à usage unique et de courte vie — c'est ce
// qu'exige la norme, et le réutiliser doit échouer.
const codes = new Map();
const CODE_TTL_MS = 2 * 60 * 1000;

function base() {
  const app = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return `${app}/dev/oidc`;
}

function purgeCodes() {
  const now = Date.now();
  for (const [k, v] of codes) if (now - v.at > CODE_TTL_MS) codes.delete(k);
}

router.get('/.well-known/openid-configuration', (_req, res) => {
  res.json({
    issuer: base(),
    authorization_endpoint: `${base()}/authorize`,
    token_endpoint: `${base()}/token`,
    userinfo_endpoint: `${base()}/userinfo`,
    jwks_uri: `${base()}/jwks.json`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email', 'groups'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
    claims_supported: ['sub', 'name', 'email', 'email_verified', 'groups']
  });
});

router.get('/jwks.json', (_req, res) => res.json({ keys: [keys().jwk] }));

// Écran de connexion : il remplace la mire du partenaire. Les champs sont
// libres, pour pouvoir éprouver un claim de groupe ou une adresse précise.
router.get('/authorize', (req, res) => {
  const q = req.query;
  for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) {
    if (!q[k]) return res.status(400).send(`paramètre manquant : ${k}`);
  }
  if (String(q.code_challenge_method || '') !== 'S256') {
    return res.status(400).send('code_challenge_method doit valoir S256');
  }
  const esc = (v) => String(v || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>IdP de test — connexion</title>
<body style="font-family:system-ui;max-width:28rem;margin:3rem auto">
<h1 style="font-size:1.1rem">Fournisseur d'identité de TEST</h1>
<p style="color:#666">Aucune vérification réelle. Sert à éprouver le parcours OpenID.</p>
<form method="POST" action="${esc(base())}/authorize">
  <input type="hidden" name="client_id" value="${esc(q.client_id)}">
  <input type="hidden" name="redirect_uri" value="${esc(q.redirect_uri)}">
  <input type="hidden" name="state" value="${esc(q.state)}">
  <input type="hidden" name="nonce" value="${esc(q.nonce)}">
  <input type="hidden" name="code_challenge" value="${esc(q.code_challenge)}">
  <label>Identifiant (sub)<br><input name="sub" value="user-001" style="width:100%"></label><br><br>
  <label>Nom<br><input name="name" value="Camille Durand" style="width:100%"></label><br><br>
  <label>Courriel<br><input name="email" value="camille@partenaire.test" style="width:100%"></label><br><br>
  <label>Groupes (séparés par une virgule)<br><input name="groups" value="abonnes" style="width:100%"></label><br><br>
  <button type="submit">Se connecter</button>
  <button type="submit" name="deny" value="1" style="margin-left:.5rem">Refuser</button>
</form></body>`);
});

router.post('/authorize', (req, res) => {
  const b = req.body || {};
  const redirectUri = String(b.redirect_uri || '');
  if (!redirectUri) return res.status(400).send('redirect_uri manquant');

  const url = new URL(redirectUri);
  // Le refus se signale par une redirection, pas par une page d'erreur : c'est
  // ce que fait un vrai IdP, et le client doit savoir le traiter.
  if (b.deny) {
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'L\'utilisateur a refusé la demande');
    url.searchParams.set('state', String(b.state || ''));
    return res.redirect(url.toString());
  }

  purgeCodes();
  const code = crypto.randomBytes(24).toString('base64url');
  codes.set(code, {
    at: Date.now(),
    clientId: String(b.client_id || ''),
    redirectUri,
    nonce: String(b.nonce || ''),
    challenge: String(b.code_challenge || ''),
    profile: {
      sub: String(b.sub || 'user-001'),
      name: String(b.name || ''),
      email: String(b.email || ''),
      email_verified: true,
      groups: String(b.groups || '').split(',').map(s => s.trim()).filter(Boolean)
    }
  });

  url.searchParams.set('code', code);
  url.searchParams.set('state', String(b.state || ''));
  return res.redirect(url.toString());
});

router.post('/token', (req, res) => {
  purgeCodes();
  const b = req.body || {};
  if (String(b.grant_type || '') !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  const entry = codes.get(String(b.code || ''));
  if (!entry) return res.status(400).json({ error: 'invalid_grant', error_description: 'code inconnu, expiré ou déjà utilisé' });
  // Usage unique : la norme l'exige, et un code rejouable annulerait l'intérêt
  // de PKCE.
  codes.delete(String(b.code || ''));

  if (String(b.redirect_uri || '') !== entry.redirectUri) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri différent de celui de la demande' });
  }
  const verifier = String(b.code_verifier || '');
  if (!verifier) return res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier manquant' });
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  if (computed !== entry.challenge) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier ne correspond pas au code_challenge' });
  }

  const now = Math.floor(Date.now() / 1000);
  const idToken = jwt.sign(
    { ...entry.profile, nonce: entry.nonce, iat: now, auth_time: now },
    keys().privatePem,
    { algorithm: 'RS256', issuer: base(), audience: entry.clientId, expiresIn: 300, keyid: keys().kid }
  );
  const accessToken = crypto.randomBytes(24).toString('base64url');
  codes.set('at:' + accessToken, { at: Date.now(), profile: entry.profile });

  return res.json({
    token_type: 'Bearer', expires_in: 300,
    access_token: accessToken, id_token: idToken,
    scope: 'openid profile email'
  });
});

router.get('/userinfo', (req, res) => {
  purgeCodes();
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const entry = token ? codes.get('at:' + token) : null;
  if (!entry) return res.status(401).json({ error: 'invalid_token' });
  return res.json(entry.profile);
});

export default router;
