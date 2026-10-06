// src/services/partner-oidc.js
//
// OpenID Connect pour l'accès partenaire — Authorization Code + PKCE.
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
//   signature (JWKS), iss, aud, exp — l'id_token vient bien de l'émetteur
//            attendu, nous est destiné, et n'est pas périmé.
//
// Aucune dépendance ajoutée : `jsonwebtoken` vérifie RS256, et Node convertit
// un JWK en clé publique nativement.
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const DISCOVERY_PATH = '/.well-known/openid-configuration';
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map();   // issuer -> { at, doc }
const jwksCache = new Map();        // jwks_uri -> { at, keys }

/** Le partenaire est-il configuré pour OIDC ? */
export function oidcConfigFor(partnerCfg) {
  const o = partnerCfg?.oidc;
  if (!o || typeof o !== 'object') return null;
  const issuer = String(o.issuer || '').trim().replace(/\/+$/, '');
  const clientId = String(o.clientId || '').trim();
  if (!issuer || !clientId) return null;
  return {
    issuer,
    clientId,
    clientSecret: String(o.clientSecret || '').trim(),
    // `openid` est obligatoire : sans lui le serveur n'est pas tenu de rendre
    // un id_token, et c'est lui qui porte l'identité.
    scopes: Array.isArray(o.scopes) && o.scopes.length
      ? Array.from(new Set(['openid', ...o.scopes.map(s => String(s).trim()).filter(Boolean)]))
      : ['openid', 'profile', 'email'],
    // Quel claim identifie le bénéficiaire chez ce partenaire. `sub` est le
    // seul garanti stable par la norme ; les autres sont là parce que les
    // annuaires d'entreprise exposent souvent autre chose.
    subjectClaim: String(o.subjectClaim || 'sub').trim(),
    emailClaim: String(o.emailClaim || 'email').trim(),
    nameClaim: String(o.nameClaim || 'name').trim(),
    // Restreindre l'accès à un groupe / rôle porté par un claim.
    requiredClaim: o.requiredClaim && typeof o.requiredClaim === 'object'
      ? { claim: String(o.requiredClaim.claim || '').trim(), value: o.requiredClaim.value }
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
    const detail = json?.error_description || json?.error || text.slice(0, 200);
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
  if (String(doc.issuer || '').replace(/\/+$/, '') !== issuer) {
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
  const doc = await discover(oidc.issuer);
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', oidc.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', oidc.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Échange le code contre les jetons, puis VÉRIFIE l'id_token.
 *
 * L'ordre importe : tant que la signature, l'émetteur, le destinataire et le
 * nonce ne sont pas vérifiés, le contenu du jeton n'est qu'une affirmation du
 * réseau.
 */
export async function exchangeCode({ oidc, redirectUri, code, verifier, nonce }) {
  const doc = await discover(oidc.issuer);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: oidc.clientId,
    code_verifier: verifier
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  // client_secret_basic quand un secret est configuré, sinon client public
  // (PKCE seul) — les deux cas existent chez les partenaires.
  if (oidc.clientSecret) {
    headers.Authorization = 'Basic ' + Buffer
      .from(`${encodeURIComponent(oidc.clientId)}:${encodeURIComponent(oidc.clientSecret)}`)
      .toString('base64');
  }

  const tokens = await fetchJson(doc.token_endpoint, { method: 'POST', headers, body: body.toString() });
  const idToken = String(tokens.id_token || '');
  if (!idToken) throw new Error('réponse sans id_token');

  const header = JSON.parse(Buffer.from(idToken.split('.')[0] || '', 'base64url').toString('utf8'));
  const pem = await publicKeyFor(doc.jwks_uri, header.kid, header.alg);

  const claims = jwt.verify(idToken, pem, {
    algorithms: [header.alg === 'RS512' ? 'RS512' : header.alg === 'RS384' ? 'RS384' : 'RS256'],
    issuer: oidc.issuer,
    audience: oidc.clientId,
    clockTolerance: 60
  });

  // Le nonce ne peut pas être délégué à la bibliothèque : c'est à nous de
  // savoir lequel nous avions émis.
  if (!claims.nonce || claims.nonce !== nonce) {
    throw new Error('nonce absent ou différent de celui émis');
  }

  return { claims, accessToken: tokens.access_token || '', raw: tokens };
}

/** Identité retenue pour la session, et contrôle d'appartenance éventuel. */
export function identityFromClaims(oidc, claims) {
  const pick = (name) => (name && claims[name] !== undefined ? claims[name] : undefined);
  const subject = String(pick(oidc.subjectClaim) ?? claims.sub ?? '').trim();
  if (!subject) throw new Error(`claim « ${oidc.subjectClaim} » absent de l'id_token`);

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
