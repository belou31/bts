// src/services/partner-oidc.js
//
// OpenID Connect pour l'accès partenaire — Authorization Code.
//
// S'AJOUTE au jeton statique et à l'intégration par iframe, sans les
// remplacer : un partenaire sans bloc `oidc` dans sa configuration continue
// exactement comme avant. C'est ce que demande la réalité du terrain, où
// chaque partenaire arrive avec son propre niveau d'outillage.
//
// Ce qui est vérifié, et pourquoi chaque contrôle compte :
//   state  — lie le retour à la demande partie de CE navigateur. Sans lui,
//            un tiers peut faire aboutir une connexion qu'il a initiée.
//   nonce  — lie l'id_token à CETTE demande. Sans lui, un jeton capté
//            ailleurs peut être rejoué.
//   PKCE   — le code d'autorisation ne vaut rien sans le vérificateur, qui
//            n'a jamais quitté le serveur. Protège si le code fuite.
//   signature, iss, aud, exp — l'id_token vient bien de l'émetteur attendu,
//            nous est destiné, et n'est pas périmé.
//
// TOUS LES IdP NE SUIVENT PAS LA NORME DE LA MÊME FAÇON. Le profil AISC/SFI
// (Castelis), premier partenaire raccordé, n'expose ni document de découverte
// ni JWKS, ignore PKCE, attend un corps JSON sur /token et ne met aucun claim
// de profil dans l'id_token — il faut interroger son endpoint `infoUser`.
// D'où les réglages ci-dessous : chacun décrit un écart constaté, et le défaut
// reste le comportement normalisé.
//
// Aucune dépendance ajoutée : `jsonwebtoken` vérifie RS256, et Node convertit
// un JWK en clé publique nativement.
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const DISCOVERY_PATH = '/.well-known/openid-configuration';
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map();   // issuer -> { at, doc }
const jwksCache = new Map();        // jwks_uri -> { at, keys }

const SIGN_ALGS = ['RS256', 'RS384', 'RS512'];

function str(v) { return String(v ?? '').trim(); }

// Une clé publique recopiée dans un JSON arrive souvent avec des `\n` littéraux
// ou sans les lignes d'encadrement. On accepte les deux plutôt que de laisser
// l'exploitant deviner pourquoi « la clé ne marche pas ».
function normalizePem(raw) {
  const value = str(raw).replace(/\\n/g, '\n');
  if (!value) return '';
  if (value.includes('-----BEGIN')) return value;
  const body = value.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') || '';
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

/** Le partenaire est-il configuré pour OIDC ? */
export function oidcConfigFor(partnerCfg) {
  const o = partnerCfg?.oidc;
  if (!o || typeof o !== 'object') return null;
  const issuer = str(o.issuer).replace(/\/+$/, '');
  const clientId = str(o.clientId);
  if (!issuer || !clientId) return null;

  const ep = o.endpoints && typeof o.endpoints === 'object' ? o.endpoints : {};
  const clientSecret = str(o.clientSecret);

  return {
    issuer,
    clientId,
    clientSecret,
    // Endpoints explicites, pour un IdP sans document de découverte. Renseignés,
    // ils l'emportent ; absents, la découverte reste le chemin normal.
    endpoints: {
      authorization: str(ep.authorization),
      token: str(ep.token),
      userinfo: str(ep.userinfo),
      jwks: str(ep.jwks)
    },
    // `openid` est obligatoire : sans lui le serveur n'est pas tenu de rendre
    // un id_token, et c'est lui qui porte l'identité.
    scopes: Array.isArray(o.scopes) && o.scopes.length
      ? Array.from(new Set(['openid', ...o.scopes.map(s => str(s)).filter(Boolean)]))
      : ['openid', 'profile', 'email'],
    // PKCE par défaut. Désactivable car un IdP qui ne le connaît pas peut
    // rejeter les paramètres inconnus — et c'est le cas de SFI.
    pkce: o.pkce !== false,
    // Corps de la demande de jeton : `form` est ce qu'exige RFC 6749 ; `json`
    // est l'écart de SFI.
    tokenRequest: o.tokenRequest === 'json' ? 'json' : 'form',
    // Authentification du client sur /token.
    clientAuth: ['basic', 'body', 'none'].includes(o.clientAuth)
      ? o.clientAuth
      : (clientSecret ? 'basic' : 'none'),
    // Interroger l'endpoint userinfo après l'échange. Nécessaire quand
    // l'id_token ne porte que iss/sub/aud/exp, comme chez SFI.
    fetchUserInfo: o.fetchUserInfo === true,
    // Clé publique de vérification fournie hors bande, faute de JWKS.
    idTokenPublicKey: normalizePem(o.idTokenPublicKey),
    // Paramètres supplémentaires sur /authorize (SFI documente `prompt`).
    authorizeParams: o.authorizeParams && typeof o.authorizeParams === 'object'
      ? o.authorizeParams : null,
    // Quel claim identifie le bénéficiaire chez ce partenaire. `sub` est le
    // seul garanti stable par la norme ; les autres sont là parce que les
    // annuaires d'entreprise exposent souvent autre chose.
    subjectClaim: str(o.subjectClaim) || 'sub',
    emailClaim: str(o.emailClaim) || 'email',
    nameClaim: str(o.nameClaim) || 'name',
    // Restreindre l'accès à un groupe / rôle porté par un claim.
    requiredClaim: o.requiredClaim && typeof o.requiredClaim === 'object'
      ? { claim: str(o.requiredClaim.claim), value: o.requiredClaim.value }
      : null,
    // true : le jeton statique ne suffit plus pour ce partenaire.
    required: o.required === true
  };
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* laissé à null */ }
  if (!res.ok) {
    // Deux formats d'erreur à lire : celui d'OAuth 2 ({error,
    // error_description}) et le « problem detail » RFC 7807 que renvoie SFI
    // ({type, title, status, detail}).
    const detail = json?.error_description || json?.error
      || json?.detail || json?.title || text.slice(0, 200);
    throw new Error(`${url} → ${res.status} ${detail}`);
  }
  if (!json) throw new Error(`${url} → réponse non JSON`);
  return json;
}

/**
 * Document de découverte. Mis en cache : un échange de jeton ne doit pas
 * dépendre de la disponibilité de l'IdP à la seconde près.
 */
export async function discover(issuer) {
  const cached = discoveryCache.get(issuer);
  if (cached && (Date.now() - cached.at) < DISCOVERY_TTL_MS) return cached.doc;
  const doc = await fetchJson(issuer + DISCOVERY_PATH);
  if (str(doc.issuer).replace(/\/+$/, '') !== issuer) {
    // L'émetteur annoncé doit être celui qu'on a configuré, sinon un IdP
    // détourné pourrait se faire passer pour un autre.
    throw new Error(`issuer déclaré (${doc.issuer}) différent de celui configuré (${issuer})`);
  }
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!doc[k]) throw new Error(`découverte incomplète : ${k} manquant`);
  }
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

/**
 * Où taper, par découverte ou par configuration explicite.
 *
 * Dès que /authorize et /token sont configurés, on ne tente PAS la découverte :
 * chez un IdP qui n'en publie pas, l'appel échouerait et ferait échouer un
 * parcours qui n'en a pas besoin.
 */
export async function endpointsFor(oidc) {
  const ep = oidc.endpoints || {};
  if (ep.authorization && ep.token) {
    return {
      authorization_endpoint: ep.authorization,
      token_endpoint: ep.token,
      userinfo_endpoint: ep.userinfo || '',
      jwks_uri: ep.jwks || ''
    };
  }
  const doc = await discover(oidc.issuer);
  return {
    authorization_endpoint: ep.authorization || doc.authorization_endpoint,
    token_endpoint: ep.token || doc.token_endpoint,
    userinfo_endpoint: ep.userinfo || doc.userinfo_endpoint || '',
    jwks_uri: ep.jwks || doc.jwks_uri || ''
  };
}

async function publicKeyFor(jwksUri, kid, alg) {
  let entry = jwksCache.get(jwksUri);
  const stale = !entry || (Date.now() - entry.at) >= DISCOVERY_TTL_MS;
  // Un kid inconnu peut signifier une rotation de clés : on recharge une fois
  // avant de refuser.
  if (stale || !entry.keys.some(k => !kid || k.kid === kid)) {
    const jwks = await fetchJson(jwksUri);
    entry = { at: Date.now(), keys: Array.isArray(jwks.keys) ? jwks.keys : [] };
    jwksCache.set(jwksUri, entry);
  }
  const jwk = entry.keys.find(k => (!kid || k.kid === kid) && (!alg || !k.alg || k.alg === alg))
    || entry.keys.find(k => !kid || k.kid === kid);
  if (!jwk) throw new Error(`aucune clé JWKS pour kid=${kid || '(absent)'}`);
  return crypto.createPublicKey({ key: jwk, format: 'jwk' })
    .export({ type: 'spki', format: 'pem' });
}

/** PKCE S256 : le vérificateur reste côté serveur, seul son haché circule. */
export function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** URL vers laquelle envoyer le navigateur du bénéficiaire. */
export async function buildAuthorizeUrl({ oidc, redirectUri, state, nonce, challenge }) {
  const doc = await endpointsFor(oidc);
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', oidc.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', oidc.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  if (oidc.pkce) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(oidc.authorizeParams || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Vérifie l'id_token : signature, émetteur, destinataire, péremption.
 *
 * La clé vient du JWKS quand l'IdP en publie un, sinon de celle configurée à la
 * main. Si ni l'un ni l'autre, on REFUSE : un id_token non vérifié n'est qu'une
 * affirmation du réseau, et l'accepter ouvrirait l'accès à qui sait forger un
 * JWT.
 */
async function verifyIdToken({ oidc, doc, idToken, nonce }) {
  const header = JSON.parse(Buffer.from(idToken.split('.')[0] || '', 'base64url').toString('utf8'));
  const alg = SIGN_ALGS.includes(header.alg) ? header.alg : 'RS256';

  let pem = oidc.idTokenPublicKey;
  if (!pem && doc.jwks_uri) pem = await publicKeyFor(doc.jwks_uri, header.kid, header.alg);
  if (!pem) {
    throw new Error(
      'impossible de vérifier l\'id_token : ni « endpoints.jwks » ni ' +
      '« idTokenPublicKey » n\'est configuré pour ce partenaire'
    );
  }

  const claims = jwt.verify(idToken, pem, {
    algorithms: [alg],
    issuer: oidc.issuer,
    audience: oidc.clientId,
    clockTolerance: 60
  });

  // Le nonce ne peut pas être délégué à la bibliothèque : c'est à nous de
  // savoir lequel nous avions émis.
  if (!claims.nonce || claims.nonce !== nonce) {
    throw new Error('nonce absent ou différent de celui émis');
  }
  return claims;
}

/**
 * Claims de profil servis par l'endpoint userinfo.
 *
 * Le `sub` renvoyé doit être celui de l'id_token (OIDC Core §5.3.2) : sans ce
 * contrôle, un access_token obtenu pour un compte pourrait rapporter le profil
 * d'un autre.
 */
async function fetchUserInfo({ doc, accessToken, subject }) {
  if (!doc.userinfo_endpoint) {
    throw new Error('« fetchUserInfo » demandé mais aucun endpoint userinfo configuré');
  }
  if (!accessToken) throw new Error('réponse sans access_token : userinfo inaccessible');

  const info = await fetchJson(doc.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  });
  const sub = str(info.sub);
  if (sub && sub !== str(subject)) {
    throw new Error(`userinfo renvoie un autre sujet (${sub}) que l'id_token (${subject})`);
  }
  return info;
}

/**
 * Échange le code contre les jetons, puis VÉRIFIE l'id_token.
 *
 * L'ordre importe : tant que la signature, l'émetteur, le destinataire et le
 * nonce ne sont pas vérifiés, le contenu du jeton n'est qu'une affirmation du
 * réseau. Le profil n'est demandé qu'ensuite, et jamais il ne remplace les
 * claims vérifiés.
 */
export async function exchangeCode({ oidc, redirectUri, code, verifier, nonce }) {
  const doc = await endpointsFor(oidc);

  const params = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: oidc.clientId
  };
  if (oidc.pkce) params.code_verifier = verifier;
  if (oidc.clientAuth === 'body' && oidc.clientSecret) params.client_secret = oidc.clientSecret;

  const headers = { Accept: 'application/json' };
  if (oidc.clientAuth === 'basic' && oidc.clientSecret) {
    headers.Authorization = 'Basic ' + Buffer
      .from(`${encodeURIComponent(oidc.clientId)}:${encodeURIComponent(oidc.clientSecret)}`)
      .toString('base64');
  }

  let body;
  if (oidc.tokenRequest === 'json') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(params);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(params).toString();
  }

  const tokens = await fetchJson(doc.token_endpoint, { method: 'POST', headers, body });
  const idToken = str(tokens.id_token);
  if (!idToken) throw new Error('réponse sans id_token');

  const verified = await verifyIdToken({ oidc, doc, idToken, nonce });

  // Les claims vérifiés restent prioritaires : le profil complète, il ne
  // réécrit pas iss/aud/sub/exp.
  let claims = verified;
  if (oidc.fetchUserInfo) {
    const info = await fetchUserInfo({
      doc, accessToken: tokens.access_token, subject: verified.sub
    });
    claims = { ...info, ...verified };
  }

  return { claims, accessToken: tokens.access_token || '', raw: tokens };
}

/** Identité retenue pour la session, et contrôle d'appartenance éventuel. */
export function identityFromClaims(oidc, claims) {
  const pick = (name) => (name && claims[name] !== undefined ? claims[name] : undefined);
  const subject = String(pick(oidc.subjectClaim) ?? claims.sub ?? '').trim();
  if (!subject) throw new Error(`claim « ${oidc.subjectClaim} » absent de l'identité reçue`);

  if (oidc.requiredClaim?.claim) {
    const actual = claims[oidc.requiredClaim.claim];
    const expected = oidc.requiredClaim.value;
    const ok = Array.isArray(actual)
      ? actual.map(String).includes(String(expected))
      : String(actual ?? '') === String(expected);
    if (!ok) {
      const err = new Error(`accès refusé : ${oidc.requiredClaim.claim} ne vaut pas « ${expected} »`);
      err.code = 'claim_mismatch';
      throw err;
    }
  }

  return {
    subject,
    email: String(pick(oidc.emailClaim) ?? '').trim(),
    name: String(pick(oidc.nameClaim) ?? '').trim()
  };
}
