// stub_oidc/idp.js
//
// Fournisseur d'identité FACTICE pour le développement : deux profils servis
// par le même routeur.
//
//   standard  (racine)  : OpenID Connect conforme — découverte, PKCE S256,
//                         JWKS, id_token complet, userinfo JSON.
//   sfi       (/sfi)    : AISC / Castelis tel que la préproduction le sert —
//                         ni découverte ni JWKS, client_secret exigé sur
//                         /token, erreurs OAuth en HTTP 200, id_token nu,
//                         infoUser en JWT signé.
//
// Un SCÉNARIO choisit le comportement : le défaut se règle sur le tableau de
// bord (/), et chaque connexion peut le remplacer sur l'écran de connexion.
// Utilisé par stub_oidc/server.js (serveur autonome) et par les harnais
// npm run test:oidc / test:oidc-sfi.
//
// ⚠️ Délivre une identité à quiconque la demande : jamais en production.
import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';

export const SCENARIOS = {
  manual:         'Écran de connexion (choix à chaque fois)',
  auto:           'Connexion automatique avec l\'identité par défaut',
  deny:           'Refus de l\'utilisateur (access_denied)',
  no_nonce:       'id_token sans nonce',
  wrong_nonce:    'id_token avec un autre nonce',
  bad_signature:  'id_token signé par une autre clé',
  expired:        'id_token expiré',
  token_error:    '/token refuse le client (invalid_client)',
  userinfo_error: 'userinfo / infoUser renvoie une erreur'
};

// Liste du swagger de préproduction SFI (/api/openapi.json).
const SFI_SCOPES = ['openid', 'profile', 'email', 'phone', 'address', 'od', 'family',
  'billetterie', 'partenaires', 'offline_access', 'date_sortie'];

const CODE_TTL_MS = 2 * 60 * 1000;
const MAX_EVENTS = 50;

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {object}   o
 * @param {Function} o.baseUrl  rend l'URL publique du profil standard (émetteur)
 * @param {string}  [o.keyFile] PEM de la clé privée, créé au premier lancement
 *                              et relu ensuite : une clé collée dans
 *                              partners.json survit au redémarrage du stub.
 */
export function createIdp({ baseUrl, keyFile = null } = {}) {
  const base = () => String(baseUrl()).replace(/\/+$/, '');
  const sfiBase = () => `${base()}/sfi`;

  const state = {
    scenario: 'manual',
    identities: {
      standard: { sub: 'user-001', name: 'Camille Durand', email: 'camille@partenaire.test', groups: 'abonnes' },
      sfi: {
        sub: 'M1234569', given_name: 'Jean', family_name: 'DUPONT', email: 'jean.dupont@aisc.test',
        conjoint: '1', autres_ad: '2', code_societe: 'AER'
      }
    },
    events: []
  };

  function record(profile, endpoint, detail) {
    state.events.unshift({ at: new Date().toISOString(), profile, endpoint, detail });
    state.events.length = Math.min(state.events.length, MAX_EVENTS);
  }

  // ── Clés ────────────────────────────────────────────────────────────────
  let KEYS = null;
  function keys() {
    if (KEYS) return KEYS;
    let privateKey;
    if (keyFile && fs.existsSync(keyFile)) {
      privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
    } else {
      privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
      if (keyFile) {
        fs.mkdirSync(path.dirname(keyFile), { recursive: true });
        fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      }
    }
    const publicKey = crypto.createPublicKey(privateKey);
    const jwk = publicKey.export({ format: 'jwk' });
    const kid = 'stub-' + crypto.createHash('sha256').update(jwk.n).digest('hex').slice(0, 8);
    KEYS = {
      kid,
      privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
      jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }
    };
    return KEYS;
  }
  // Clé étrangère, pour le scénario bad_signature.
  let ROGUE = null;
  const roguePem = () => (ROGUE ||= crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' }));

  // ── Codes et jetons d'accès, en mémoire, à usage unique ─────────────────
  const codes = new Map();
  function purge() {
    const now = Date.now();
    for (const [k, v] of codes) if (now - v.at > CODE_TTL_MS) codes.delete(k);
  }

  // Scénario d'une connexion : celui choisi sur l'écran, sinon le défaut.
  // Les anciennes cases (deny, no_nonce, infouser_error) restent comprises.
  function scenarioOf(form) {
    if (form.deny) return 'deny';
    if (form.no_nonce) return 'no_nonce';
    if (form.infouser_error) return 'userinfo_error';
    const s = String(form.scenario || '');
    return SCENARIOS[s] && s !== 'manual' && s !== 'auto' ? s : 'ok';
  }

  function signIdToken({ claims, nonce, audience, issuer, subject, scenario }) {
    const now = Math.floor(Date.now() / 1000);
    const payload = { ...claims, iat: now };
    if (scenario === 'expired') { payload.iat = now - 3600; payload.exp = now - 600; }
    if (scenario !== 'no_nonce') payload.nonce = scenario === 'wrong_nonce' ? 'nonce-étranger' : nonce;
    const options = { algorithm: 'RS256', issuer, audience, keyid: keys().kid };
    if (subject) options.subject = subject;
    if (scenario !== 'expired') options.expiresIn = 300;
    return jwt.sign(payload, scenario === 'bad_signature' ? roguePem() : keys().privatePem, options);
  }

  function redirectError(res, redirectUri, state, error, description) {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    url.searchParams.set('state', String(state || ''));
    return res.redirect(url.toString());
  }

  function issueCode(res, prefix, form, entry) {
    purge();
    const code = crypto.randomBytes(24).toString('base64url');
    codes.set(prefix + code, { at: Date.now(), ...entry });
    const url = new URL(entry.redirectUri);
    url.searchParams.set('code', code);
    url.searchParams.set('state', String(form.state || ''));
    return res.redirect(url.toString());
  }

  const router = Router();

  // ════════════════════════ Profil STANDARD ════════════════════════════════
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
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      claims_supported: ['sub', 'name', 'email', 'email_verified', 'groups']
    });
  });

  router.get('/jwks.json', (_req, res) => res.json({ keys: [keys().jwk] }));
  // Clé publique en PEM, pour « idTokenPublicKey » (hors norme, test seulement).
  router.get('/keys/public.pem', (_req, res) => res.type('text/plain').send(keys().publicPem));
  router.get('/sfi/keys/public.pem', (_req, res) => res.type('text/plain').send(keys().publicPem));

  function standardApprove(res, form) {
    const scenario = scenarioOf(form);
    record('standard', 'authorize', `${form.client_id} → ${scenario}`);
    if (scenario === 'deny') {
      return redirectError(res, form.redirect_uri, form.state, 'access_denied', 'L\'utilisateur a refusé la demande');
    }
    return issueCode(res, 'std:', form, {
      clientId: String(form.client_id || ''),
      redirectUri: String(form.redirect_uri),
      nonce: String(form.nonce || ''),
      challenge: String(form.code_challenge || ''),
      scenario,
      profile: {
        sub: String(form.sub || 'user-001'),
        name: String(form.name || ''),
        email: String(form.email || ''),
        email_verified: true,
        groups: String(form.groups || '').split(',').map(s => s.trim()).filter(Boolean)
      }
    });
  }

  router.get('/authorize', (req, res) => {
    const q = req.query;
    for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) {
      if (!q[k]) return res.status(400).send(`paramètre manquant : ${k}`);
    }
    if (String(q.code_challenge_method || '') !== 'S256') {
      return res.status(400).send('code_challenge_method doit valoir S256');
    }
    const id = state.identities.standard;
    if (state.scenario !== 'manual') {
      return standardApprove(res, { ...q, ...id, scenario: state.scenario });
    }
    const hidden = ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']
      .map(k => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('');
    res.type('html').send(loginPage({
      title: 'Fournisseur d\'identité de TEST — profil standard',
      action: `${base()}/authorize`,
      hidden,
      fields: [
        ['sub', 'Identifiant (sub)', id.sub], ['name', 'Nom', id.name],
        ['email', 'Courriel', id.email], ['groups', 'Groupes (séparés par une virgule)', id.groups]
      ]
    }));
  });

  router.post('/authorize', (req, res) => {
    const b = req.body || {};
    if (!b.redirect_uri) return res.status(400).send('redirect_uri manquant');
    return standardApprove(res, b);
  });

  router.post('/token', (req, res) => {
    purge();
    const b = req.body || {};
    if (String(b.grant_type || '') !== 'authorization_code') {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }
    const entry = codes.get('std:' + String(b.code || ''));
    if (!entry) return res.status(400).json({ error: 'invalid_grant', error_description: 'code inconnu, expiré ou déjà utilisé' });
    codes.delete('std:' + String(b.code || ''));          // usage unique
    if (entry.scenario === 'token_error') {
      record('standard', 'token', 'invalid_client (scénario)');
      return res.status(401).json({ error: 'invalid_client', error_description: 'Client inconnu (scénario token_error)' });
    }
    if (String(b.redirect_uri || '') !== entry.redirectUri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri différent de celui de la demande' });
    }
    const verifier = String(b.code_verifier || '');
    if (!verifier) return res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier manquant' });
    if (crypto.createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier ne correspond pas au code_challenge' });
    }

    const idToken = signIdToken({
      claims: { ...entry.profile, auth_time: Math.floor(Date.now() / 1000) },
      nonce: entry.nonce, audience: entry.clientId, issuer: base(), scenario: entry.scenario
    });
    const accessToken = crypto.randomBytes(24).toString('base64url');
    codes.set('stdat:' + accessToken, { at: Date.now(), profile: entry.profile, scenario: entry.scenario });
    record('standard', 'token', `${entry.clientId} → id_token (${entry.scenario})`);
    return res.json({
      token_type: 'Bearer', expires_in: 300,
      access_token: accessToken, id_token: idToken, scope: 'openid profile email'
    });
  });

  router.get('/userinfo', (req, res) => {
    purge();
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const entry = token ? codes.get('stdat:' + token) : null;
    if (!entry || entry.scenario === 'userinfo_error') {
      record('standard', 'userinfo', 'invalid_token');
      return res.status(401).json({ error: 'invalid_token' });
    }
    record('standard', 'userinfo', entry.profile.sub);
    return res.json(entry.profile);
  });

  // ════════════════════════ Profil SFI (AISC) ══════════════════════════════
  // Erreur OAuth {error, error_description} ; /token la rend en HTTP 200.
  const sfiError = (res, status, error, description) =>
    res.status(status).json({ error, error_description: description });

  // infoUser répond un JWT signé (application/jwt), erreurs comprises.
  function sfiSignedReply(res, payload) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return res.status(200).type('application/jwt')
      .send(jwt.sign(body, keys().privatePem, { algorithm: 'RS256', keyid: keys().kid }));
  }

  // Profil tel que le rend infoUser, filtré par scope. Dates au format
  // JJ/MM/AAAA du partenaire, pas ISO 8601.
  function sfiProfile(form, scopes) {
    const has = (s) => scopes.includes(s);
    const sub = String(form.sub || 'M1234569');
    const out = { sub };
    const withSpouse = String(form.conjoint ?? '1') !== '0';
    const nKids = Math.max(0, Math.min(9, parseInt(form.autres_ad ?? '2', 10) || 0));
    const kidNames = ['Louis', 'Emma', 'Hugo', 'Léa', 'Noé', 'Jade', 'Tom', 'Zoé', 'Paul'];
    const kidBirth = ['22/01/2014', '05/06/2005', '11/09/2017', '30/03/2010', '02/12/2019', '17/07/2008', '08/02/2015', '25/10/2012', '14/05/2020'];
    const kids = Array.from({ length: nKids }, (_, i) => ({
      matricule: `${sub}-${String(i + 3).padStart(2, '0')}`, given_name: kidNames[i], birthdate: kidBirth[i]
    }));
    const givenName = String(form.given_name || 'Jean');
    const familyName = String(form.family_name || 'DUPONT');
    const email = String(form.email || 'jean.dupont@aisc.test');

    if (has('partenaires')) {
      Object.assign(out, {
        given_name: givenName, family_name: familyName, email,
        matricule: sub, conjoint: withSpouse, autres_ad: kids.length
      });
    }
    if (has('profile')) {
      Object.assign(out, {
        name: String(form.name || `${givenName} ${familyName}`), given_name: givenName, family_name: familyName,
        birthdate: String(form.birthdate || '14/03/1978'), updated_at: '02/10/2026'
      });
    }
    if (has('email')) Object.assign(out, { email, email_verified: true });
    if (has('phone')) Object.assign(out, { phone_number: '+33 5 61 00 00 00' });
    if (has('address')) {
      Object.assign(out, {
        address: { street_address: '1 rond-point Maurice Bellonte', postal_code: '31700', locality: 'Blagnac', country: 'FR' }
      });
    }
    if (has('od')) Object.assign(out, { od: String(form.od || 'OD_TOULOUSE') });
    if (has('family')) {
      // Schéma PersonInfo : conjoint d'abord, puis les enfants.
      const person = (p, gender) => ({
        matricule: p.matricule, name: `${gender === 'Feminin' ? 'Madame' : 'Monsieur'} ${familyName} ${p.given_name}`,
        family_name: familyName, given_name: p.given_name, usage_family_name: '', usage_given_name: '',
        gender, birthdate: p.birthdate
      });
      out.family = [
        ...(withSpouse ? [person({ matricule: `${sub}-02`, given_name: 'Marie', birthdate: '09/07/1980' }, 'Feminin')] : []),
        ...kids.map((k, i) => person(k, i % 2 ? 'Feminin' : 'Masculin'))
      ];
    }
    if (has('billetterie')) {
      out.billetterie = {
        matricule_groupe: sub,
        societe: String(form.societe || '18537207'),
        code_societe: String(form.code_societe || 'AER'),
        conjoint: withSpouse, autres_ad: kids.length, subvention: 0
      };
    }
    return out;
  }

  function sfiApprove(res, form) {
    const scenario = scenarioOf(form);
    record('sfi', 'authorize', `${form.client_id} → ${scenario}`);
    if (!form.redirect_uri) return sfiError(res, 400, 'invalid_request', 'redirect_uri manquant');
    if (scenario === 'deny') {
      return redirectError(res, form.redirect_uri, form.state, 'access_denied', 'L\'ayant droit a refusé la demande');
    }
    const scopes = String(form.scope || 'openid').split(/\s+/).filter(Boolean);
    return issueCode(res, 'sfi:', form, {
      clientId: String(form.client_id || ''),
      redirectUri: String(form.redirect_uri),
      nonce: String(form.nonce || ''),
      scopes, scenario,
      profile: sfiProfile(form, scopes)
    });
  }

  function sfiAuthorize(q, res) {
    // La spec liste /authorize en POST mais l'illustre en GET ; un navigateur
    // redirigé fait un GET.
    for (const k of ['client_id', 'response_type', 'redirect_uri', 'state', 'scope']) {
      if (!q[k]) return sfiError(res, 400, 'invalid_request', `Paramètre obligatoire manquant : ${k}`);
    }
    if (String(q.response_type) !== 'code') {
      return sfiError(res, 400, 'unsupported_response_type', 'Seul response_type=code est accepté');
    }
    const unknown = String(q.scope).split(/\s+/).filter(s => s && !SFI_SCOPES.includes(s));
    if (unknown.length) return sfiError(res, 400, 'invalid_scope', `Scope inconnu : ${unknown.join(', ')}`);
    // prompt=none : le stub n'entretient pas de session SFI.
    if (String(q.prompt || '') === 'none') {
      return redirectError(res, String(q.redirect_uri), q.state, 'login_required', 'Aucune session SFI active');
    }
    const id = state.identities.sfi;
    if (state.scenario !== 'manual') return sfiApprove(res, { ...q, ...id, scenario: state.scenario });

    const hidden = ['client_id', 'redirect_uri', 'state', 'nonce', 'scope']
      .map(k => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('');
    return res.type('html').send(loginPage({
      title: 'SFI (AISC) — fournisseur d\'identité de TEST',
      action: `${sfiBase()}/oauth/v1/authorize`,
      hidden,
      note: `Scopes demandés : ${esc(q.scope)}`,
      fields: [
        ['sub', 'Matricule (sub)', id.sub], ['given_name', 'Prénom', id.given_name],
        ['family_name', 'Nom', id.family_name], ['email', 'Courriel', id.email],
        ['conjoint', 'Conjoint (1 = oui, 0 = non)', id.conjoint], ['autres_ad', 'Enfants (autres_ad)', id.autres_ad],
        ['code_societe', 'Code société (billetterie)', id.code_societe]
      ]
    }));
  }

  router.get('/sfi/oauth/v1/authorize', (req, res) => sfiAuthorize(req.query || {}, res));
  router.post('/sfi/oauth/v1/authorize', (req, res) => sfiApprove(res, req.body || {}));

  router.post('/sfi/oauth/v1/token', (req, res) => {
    purge();
    const b = req.body || {};
    // Erreurs OAuth en HTTP 200, comme la préproduction.
    const oauthError = (error, description) => {
      record('sfi', 'token', error);
      return sfiError(res, 200, error, description);
    };
    const grant = String(b.grant_type || '');
    if (!String(b.client_id || '')) return oauthError('invalid_request', 'client_id manquant');
    if (!String(b.client_secret || '')) {
      record('sfi', 'token', 'unknow_client (400)');
      return sfiError(res, 400, 'unknow_client', 'Client inconnu ou secret absent');
    }
    if (grant === 'client_credentials') {
      const at = crypto.randomBytes(24).toString('base64url');
      codes.set('sfiat:' + at, { at: Date.now(), profile: null, scopes: [] });
      record('sfi', 'token', `${b.client_id} → client_credentials`);
      return res.json({ token_type: 'Bearer', expires_in: 1800, access_token: at });
    }
    if (grant !== 'authorization_code') {
      return oauthError('unsupported_grant_type', `grant_type non pris en charge : ${grant || '(absent)'}`);
    }
    const key = 'sfi:' + String(b.code || '');
    const entry = codes.get(key);
    if (!entry) return oauthError('invalid_grant', 'Code inconnu, expiré ou déjà utilisé');
    codes.delete(key);                                      // usage unique
    if (entry.scenario === 'token_error') return oauthError('invalid_client', 'The client credentials are invalid');
    if (String(b.client_id) !== entry.clientId) return oauthError('invalid_client', 'client_id différent de celui de la demande');
    if (String(b.redirect_uri || '') !== entry.redirectUri) {
      return oauthError('redirect_uri_mismatch', 'redirect_uri différente de celle de l\'autorisation');
    }

    // id_token NU : iss, iat, exp, sub, aud (+ nonce). Barre finale sur iss
    // comme dans l'exemple de la spec (§4.2.2.2.2).
    const idToken = signIdToken({
      claims: {}, nonce: entry.nonce, audience: entry.clientId, issuer: `${sfiBase()}/`,
      subject: entry.profile.sub, scenario: entry.scenario
    });
    const accessToken = crypto.randomBytes(24).toString('base64url');
    codes.set('sfiat:' + accessToken, { at: Date.now(), profile: entry.profile, scopes: entry.scopes, scenario: entry.scenario });
    record('sfi', 'token', `${entry.clientId} → id_token (${entry.scenario})`);
    return res.json({
      token_type: 'Bearer', expires_in: 1800, access_token: accessToken, id_token: idToken,
      refresh_token: crypto.randomBytes(24).toString('base64url'), scope: entry.scopes.join(' ')
    });
  });

  router.get('/sfi/oauth/v1/infoUser', (req, res) => {
    purge();
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    // Jamais de 401/403 : toujours un JWT signé en 200.
    if (!token) { record('sfi', 'infoUser', 'jeton absent'); return sfiSignedReply(res, []); }
    const entry = codes.get('sfiat:' + token);
    if (!entry || entry.scenario === 'userinfo_error') {
      record('sfi', 'infoUser', 'invalid_token');
      return sfiSignedReply(res, { error: 'invalid_token', error_description: 'Jeton d\'accès inconnu ou expiré' });
    }
    if (!entry.profile) {
      record('sfi', 'infoUser', 'insufficient_scope');
      return sfiSignedReply(res, { error: 'insufficient_scope', error_description: 'Jeton sans scope openid' });
    }
    record('sfi', 'infoUser', entry.profile.sub);
    return sfiSignedReply(res, entry.profile);
  });

  // ── Écran de connexion commun ───────────────────────────────────────────
  function loginPage({ title, action, hidden, fields, note = '' }) {
    const options = Object.entries(SCENARIOS).filter(([k]) => k !== 'manual' && k !== 'auto')
      .map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('');
    const inputs = fields.map(([name, label, value]) =>
      `<label>${esc(label)}<input name="${name}" value="${esc(value)}"></label>`).join('');
    return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui;max-width:30rem;margin:2.5rem auto;padding:0 1rem;color:#1d2733}
label{display:block;margin:.6rem 0;font-size:.9rem}input,select{display:block;width:100%;padding:.4rem;margin-top:.2rem;box-sizing:border-box}
.muted{color:#667;font-size:.85rem}button{padding:.5rem 1rem;margin-right:.5rem}</style>
<h1 style="font-size:1.1rem">${esc(title)}</h1>
<p class="muted">Aucune vérification réelle. ${note}</p>
<form method="POST" action="${esc(action)}">${hidden}${inputs}
<label>Scénario de cette connexion<select name="scenario"><option value="ok">Normal</option>${options}</select></label>
<button type="submit">Se connecter</button><button type="submit" name="deny" value="1">Refuser</button>
</form><p class="muted"><a href="${esc(base())}/">Tableau de bord du stub</a></p>`;
  }

  return { router, state, keys, base, sfiBase };
}
