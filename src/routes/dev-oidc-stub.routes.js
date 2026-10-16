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

// ---------------------------------------------------------------------------
// Profil AISC / SFI (Castelis) — OpenIDConnect_SFI v2.2
//
// Volontairement NON conforme à la norme, parce que le vrai ne l'est pas : la
// spec du partenaire ne publie ni document de découverte ni JWKS, ne mentionne
// pas PKCE, attend un corps JSON sur /token sans client_secret, ne met aucun
// claim de profil dans l'id_token (il faut appeler infoUser) et formate ses
// erreurs en « problem detail » RFC 7807. Émuler la norme ici aurait validé un
// client qui échouerait en face du vrai service.
//
// Émetteur : <APP_URL>/dev/oidc/sfi
// Endpoints : /dev/oidc/sfi/oauth/v1/{authorize,token,infoUser}
// ---------------------------------------------------------------------------

function sfiBase() { return `${base()}/sfi`; }

// Erreur OAuth {error, error_description}, comme la préproduction SFI. Le
// format RFC 7807 de la spec 2016 n'est pas celui qu'elle sert : /token
// répond même ses erreurs en HTTP 200 (d'où le statut paramétrable).
function sfiError(res, status, error, description) {
  return res.status(status).json({ error, error_description: description });
}

// Liste du swagger de préproduction (/api/openapi.json).
const SFI_SCOPES = ['openid', 'profile', 'email', 'phone', 'address', 'od', 'family',
  'billetterie', 'partenaires', 'offline_access', 'date_sortie'];

// infoUser répond un JWT signé (application/jwt), erreurs comprises.
function sfiSignedReply(res, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const token = jwt.sign(body, keys().privatePem, { algorithm: 'RS256', keyid: keys().kid });
  return res.status(200).type('application/jwt').send(token);
}

// Profil d'un ayant droit tel que le rend infoUser, filtré par scope. Les
// dates sont au format JJ/MM/AAAA du partenaire, pas en ISO 8601 : c'est l'un
// des points à reprendre côté BTS si l'on exploite ces champs.
function sfiProfile(form, scopes) {
  const has = (s) => scopes.includes(s);
  const out = { sub: String(form.sub || 'M1234569') };

  // Foyer de test : conjoint + deux enfants (un mineur, un majeur).
  const withSpouse = String(form.conjoint ?? '1') !== '0';
  const kids = [
    { matricule: `${out.sub}-03`, given_name: 'Louis', birthdate: '22/01/2014' },
    { matricule: `${out.sub}-04`, given_name: 'Emma', birthdate: '05/06/2005' }
  ];
  if (has('partenaires')) {
    Object.assign(out, {
      given_name: String(form.given_name || 'Jean'),
      family_name: String(form.family_name || 'DUPONT'),
      email: String(form.email || 'jean.dupont@aisc.test'),
      matricule: out.sub,
      conjoint: withSpouse,
      autres_ad: kids.length
    });
  }
  if (has('profile')) {
    Object.assign(out, {
      name: String(form.name || 'Jean DUPONT'),
      given_name: String(form.given_name || 'Jean'),
      family_name: String(form.family_name || 'DUPONT'),
      birthdate: String(form.birthdate || '14/03/1978'),
      updated_at: '02/10/2026'
    });
  }
  if (has('email')) {
    Object.assign(out, {
      email: String(form.email || 'jean.dupont@aisc.test'),
      email_verified: true
    });
  }
  if (has('phone')) Object.assign(out, { phone_number: '+33 5 61 00 00 00' });
  if (has('address')) {
    Object.assign(out, {
      address: { street_address: '1 rond-point Maurice Bellonte', postal_code: '31700', locality: 'Blagnac', country: 'FR' }
    });
  }
  if (has('od')) Object.assign(out, { od: String(form.od || 'OD_TOULOUSE') });
  if (has('family')) {
    // Schéma PersonInfo du swagger : conjoint d'abord, puis les enfants.
    const person = (p, gender) => ({
      matricule: p.matricule, name: `${gender === 'Feminin' ? 'Madame' : 'Monsieur'} Dupont ${p.given_name}`,
      family_name: 'Dupont', given_name: p.given_name, usage_family_name: '', usage_given_name: '',
      gender, birthdate: p.birthdate
    });
    out.family = [
      ...(withSpouse ? [person({ matricule: `${out.sub}-02`, given_name: 'Marie', birthdate: '09/07/1980' }, 'Feminin')] : []),
      person(kids[0], 'Masculin'),
      person(kids[1], 'Feminin')
    ];
  }
  if (has('billetterie')) {
    // Objet imbriqué, schéma BilletterieInfo du swagger de préproduction.
    out.billetterie = {
      matricule_groupe: String(form.sub || 'M1234569'),
      societe: String(form.societe || '18537207'),
      code_societe: String(form.code_societe || 'AER'),
      conjoint: true,
      autres_ad: 2,
      subvention: 0
    };
  }
  return out;
}

// HORS SPEC, et assumé : la spec impose RS256 mais ne dit pas comment la clé
// publique parvient au client. En test il faut bien la récupérer ; en
// production elle sera transmise hors bande et collée dans la configuration du
// partenaire (« idTokenPublicKey »).
router.get('/sfi/keys/public.pem', (_req, res) => {
  res.type('text/plain').send(
    crypto.createPublicKey({ key: keys().jwk, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' })
  );
});

function sfiAuthorizeScreen(q, res) {
  // La spec liste /authorize en POST dans son tableau mais l'illustre en GET ;
  // GET est ce que fait un navigateur redirigé, donc c'est ce qu'on émule.
  for (const k of ['client_id', 'response_type', 'redirect_uri', 'state', 'scope']) {
    if (!q[k]) return sfiError(res, 400, 'invalid_request', `Paramètre obligatoire manquant : ${k}`);
  }
  if (String(q.response_type) !== 'code') {
    return sfiError(res, 400, 'unsupported_response_type', 'Seul response_type=code est accepté');
  }
  const unknown = String(q.scope).split(/\s+/).filter(s => s && !SFI_SCOPES.includes(s));
  if (unknown.length) {
    return sfiError(res, 400, 'invalid_scope', `Scope inconnu : ${unknown.join(', ')}`);
  }

  // prompt=none : pas d'interaction. Le stub n'entretient pas de session, donc
  // il répond toujours login_required — ce qui est le cas à éprouver côté BTS.
  if (String(q.prompt || '') === 'none') {
    const url = new URL(String(q.redirect_uri));
    url.searchParams.set('error', 'login_required');
    url.searchParams.set('error_description', 'Aucune session SFI active');
    url.searchParams.set('state', String(q.state || ''));
    return res.redirect(url.toString());
  }

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hidden = ['client_id', 'redirect_uri', 'state', 'nonce', 'scope']
    .map(k => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('\n  ');

  res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>SFI (test) — connexion</title>
<body style="font-family:system-ui;max-width:30rem;margin:3rem auto">
<h1 style="font-size:1.1rem">SFI — fournisseur d'identité de TEST</h1>
<p style="color:#666">Émulation du profil AISC/Castelis. Aucune vérification réelle.</p>
<form method="POST" action="${esc(sfiBase())}/oauth/v1/authorize">
  ${hidden}
  <label>Matricule (sub)<br><input name="sub" value="M1234569" style="width:100%"></label><br><br>
  <label>Nom affiché<br><input name="name" value="Jean DUPONT" style="width:100%"></label><br><br>
  <label>Courriel<br><input name="email" value="jean.dupont@aisc.test" style="width:100%"></label><br><br>
  <label>Prénom<br><input name="given_name" value="Jean" style="width:100%"></label><br><br>
  <label>Nom<br><input name="family_name" value="DUPONT" style="width:100%"></label><br><br>
  <label>Code société (billetterie)<br><input name="code_societe" value="AER" style="width:100%"></label><br><br>
  <label><input type="checkbox" name="no_nonce" value="1"> id_token sans nonce (spec au pied de la lettre)</label><br><br>
  <label><input type="checkbox" name="infouser_error" value="1"> infoUser renvoie une erreur (en 200)</label><br><br>
  <button type="submit">Se connecter</button>
  <button type="submit" name="deny" value="1" style="margin-left:.5rem">Refuser</button>
</form></body>`);
}

router.get('/sfi/oauth/v1/authorize', (req, res) => sfiAuthorizeScreen(req.query || {}, res));

router.post('/sfi/oauth/v1/authorize', (req, res) => {
  const b = req.body || {};
  const redirectUri = String(b.redirect_uri || '');
  if (!redirectUri) return sfiError(res, 400, 'invalid_request', 'redirect_uri manquant');
  const url = new URL(redirectUri);

  if (b.deny) {
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'L\'ayant droit a refusé la demande');
    url.searchParams.set('state', String(b.state || ''));
    return res.redirect(url.toString());
  }

  purgeCodes();
  const code = crypto.randomBytes(24).toString('base64url');
  const scopes = String(b.scope || 'openid').split(/\s+/).filter(Boolean);
  codes.set('sfi:' + code, {
    at: Date.now(),
    clientId: String(b.client_id || ''),
    redirectUri,
    nonce: String(b.nonce || ''),
    scopes,
    form: b,
    profile: sfiProfile(b, scopes)
  });

  url.searchParams.set('code', code);
  url.searchParams.set('state', String(b.state || ''));
  return res.redirect(url.toString());
});

router.post('/sfi/oauth/v1/token', (req, res) => {
  purgeCodes();
  const b = req.body || {};
  // Erreurs OAuth en HTTP 200, comme la préproduction : un client qui se fie
  // au seul statut prendrait l'erreur pour une réussite.
  const oauthError = (error, description) => sfiError(res, 200, error, description);

  const grant = String(b.grant_type || '');
  if (!String(b.client_id || '')) return oauthError('invalid_request', 'client_id manquant');
  if (!String(b.client_secret || '')) {
    // Seul cas en 400 d'après le swagger (orthographe d'origine).
    return sfiError(res, 400, 'unknow_client', 'Client inconnu ou secret absent');
  }
  if (grant === 'client_credentials') {
    // Flux serveur à serveur : ne rend pas d'id_token.
    const at = crypto.randomBytes(24).toString('base64url');
    codes.set('sfiat:' + at, { at: Date.now(), profile: null, scopes: [] });
    return res.json({ token_type: 'Bearer', expires_in: 1800, access_token: at });
  }
  if (grant !== 'authorization_code') {
    return oauthError('unsupported_grant_type', `grant_type non pris en charge : ${grant || '(absent)'}`);
  }

  const key = 'sfi:' + String(b.code || '');
  const entry = codes.get(key);
  if (!entry) return oauthError('invalid_grant', 'Code inconnu, expiré ou déjà utilisé');
  codes.delete(key);                     // usage unique
  if (String(b.client_id) !== entry.clientId) {
    return oauthError('invalid_client', 'client_id différent de celui de la demande');
  }
  if (String(b.redirect_uri || '') !== entry.redirectUri) {
    return oauthError('redirect_uri_mismatch', 'redirect_uri différente de celle de l\'autorisation');
  }

  const now = Math.floor(Date.now() / 1000);
  // id_token volontairement NU : iss, iat, exp, sub, aud (+ nonce). Aucun
  // claim de profil, conformément à §4.2.2.2.2 — c'est ce qui oblige le client
  // à appeler infoUser.
  // « no_nonce » rejoue la spec AU PIED DE LA LETTRE : sa liste de claims
  // (§4.2.2.2.2) ne mentionne pas nonce. Si le vrai service se comporte ainsi,
  // le client doit refuser — et c'est à vérifier, pas à supposer.
  const payload = entry.form?.no_nonce ? { iat: now } : { nonce: entry.nonce, iat: now };
  const idToken = jwt.sign(
    payload,
    keys().privatePem,
    {
      // Barre finale comme dans l'exemple de la spec SFI (§4.2.2.2.2).
      algorithm: 'RS256', issuer: `${sfiBase()}/`, audience: entry.clientId,
      subject: entry.profile.sub, expiresIn: 300, keyid: keys().kid
    }
  );
  const accessToken = crypto.randomBytes(24).toString('base64url');
  codes.set('sfiat:' + accessToken, {
    at: Date.now(), profile: entry.profile, scopes: entry.scopes, infoUserError: !!entry.form?.infouser_error
  });

  return res.json({
    token_type: 'Bearer',
    expires_in: 1800,
    access_token: accessToken,
    id_token: idToken,
    refresh_token: crypto.randomBytes(24).toString('base64url'),
    scope: entry.scopes.join(' ')
  });
});

router.get('/sfi/oauth/v1/infoUser', (req, res) => {
  purgeCodes();
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  // Comportement du swagger : jamais de 401/403, toujours un JWT signé en 200.
  if (!token) return sfiSignedReply(res, []);
  const entry = codes.get('sfiat:' + token);
  if (!entry || entry.infoUserError) {
    return sfiSignedReply(res, { error: 'invalid_token', error_description: 'Jeton d\'accès inconnu ou expiré' });
  }
  if (!entry.profile) {
    return sfiSignedReply(res, { error: 'insufficient_scope', error_description: 'Jeton sans scope openid' });
  }
  return sfiSignedReply(res, entry.profile);
});

export default router;
