#!/usr/bin/env node
//
// Cas de test DEV : partenaire AISC, profil SFI v2.2 (Castelis).
//
//   npm run test:oidc-sfi
//
// Ne touche AUCUN fichier du dépôt : la configuration partenaire est fabriquée
// dans un répertoire jetable, et le test le vérifie avant de rendre la main.
//
// Éprouve le parcours contre un IdP qui NE publie PAS de découverte, PAS de
// JWKS, n'accepte PAS PKCE, veut du JSON sur /token et ne met aucun claim de
// profil dans l'id_token. Puis met chaque contrôle en échec volontairement.
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.JWT_SECRET = 'secret-de-test-sfi';
process.env.APP_ENV = 'development';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// La configuration partenaire est lue en « cwd + data/customization ». On
// déplace le cwd dans un répertoire jetable plutôt que d'écrire dans le
// fichier réel : un test ne doit pas pouvoir abîmer une configuration
// d'exploitation, même en cas d'interruption brutale.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-oidc-sfi-'));
fs.mkdirSync(path.join(SANDBOX, 'data', 'customization'), { recursive: true });
const REAL_CFG = path.join(ROOT, 'data', 'customization', 'partners.json');
const REAL_BEFORE = fs.existsSync(REAL_CFG) ? fs.readFileSync(REAL_CFG, 'utf8') : null;
process.chdir(SANDBOX);
const cfgPath = path.join(SANDBOX, 'data', 'customization', 'partners.json');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const srv = app.listen(0);
const port = srv.address().port;
process.env.APP_URL = `http://127.0.0.1:${port}`;
const B = process.env.APP_URL;

const ok = (b) => (b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ ÉCHEC\x1b[0m');
let failures = 0;
function check(label, pass, detail = '') {
  if (!pass) failures++;
  console.log(`  ${ok(pass)} ${label}${detail ? '  — ' + detail : ''}`);
}

try {
  const stub = (await import(path.join(ROOT, 'src/routes/dev-oidc-stub.routes.js'))).default;
  const partnerAuth = (await import(path.join(ROOT, 'src/routes/partner-auth.routes.js'))).default;
  app.use('/dev/oidc', stub);
  app.use(partnerAuth);

  const SFI = `${B}/dev/oidc/sfi`;
  // La clé publique arrive hors bande : en production, Castelis la fournit et
  // on la colle dans la configuration du partenaire.
  const pem = await (await fetch(`${SFI}/keys/public.pem`)).text();

  const sfiOidc = {
    issuer: SFI,
    clientId: 'bts-belougas',
    endpoints: {
      authorization: `${SFI}/oauth/v1/authorize`,
      token: `${SFI}/oauth/v1/token`,
      userinfo: `${SFI}/oauth/v1/infoUser`
    },
    scopes: ['openid', 'profile', 'email', 'billetterie'],
    pkce: false,
    tokenRequest: 'json',
    clientAuth: 'none',
    fetchUserInfo: true,
    idTokenPublicKey: pem,
    subjectClaim: 'sub',
    requiredClaim: { claim: 'societe', value: 'AIRBUS SAS' },
    required: true
  };
  const list = [{ slug: 'zzaisc', name: 'AISC (test SFI)', oidc: sfiOidc }];
  // Même partenaire, mais sans moyen de vérifier la signature : doit refuser.
  list.push({
    slug: 'zzaisc-sanscle', name: 'AISC sans clé',
    oidc: { ...sfiOidc, idTokenPublicKey: '' }
  });
  // Partenaire sans bloc oidc : les routes d'authentification doivent l'ignorer.
  list.push({ slug: 'zzjeton', name: 'Partenaire à jeton statique' });
  fs.writeFileSync(cfgPath, JSON.stringify(list, null, 2));

  const jar = new Map();
  const setJar = (res) => {
    for (const c of (res.headers.getSetCookie?.() || [])) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
      if (v) jar.set(k, v); else jar.delete(k);
    }
  };
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const get = (url, opts = {}) => fetch(url, {
    redirect: 'manual', headers: { Cookie: cookieHeader(), ...(opts.headers || {}) }, ...opts
  }).then(r => { setJar(r); return r; });

  // Ouvre /login, pousse le formulaire de l'IdP, revient sur /callback.
  const journey = async (slug, fields = {}, query = '') => {
    jar.clear();
    const r1 = await get(`${B}/partner/${slug}/auth/login${query}`);
    if (r1.status !== 302) return { stage: 'login', res: r1 };
    const au = new URL(r1.headers.get('location'));
    const form = new URLSearchParams();
    for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'scope']) {
      form.set(k, au.searchParams.get(k) || '');
    }
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const r2 = await fetch(`${SFI}/oauth/v1/authorize`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
    });
    const cb = r2.headers.get('location');
    const r3 = await get(cb);
    return { stage: 'callback', res: r3, cb, authorizeUrl: au };
  };

  console.log('\n\x1b[1m1. Ce que l\'IdP SFI n\'expose pas\x1b[0m');
  const disco = await fetch(`${SFI}/.well-known/openid-configuration`);
  check('aucun document de découverte', disco.status === 404, `HTTP ${disco.status}`);
  const jwks = await fetch(`${SFI}/oauth/v1/jwks.json`);
  check('aucun JWKS', jwks.status === 404, `HTTP ${jwks.status}`);

  console.log('\n\x1b[1m2. Demande d\'autorisation\x1b[0m');
  const j = await journey('zzaisc', {}, '?next=/partner/zzaisc/events');
  const au = j.authorizeUrl;
  check('endpoint SFI atteint sans découverte',
    au.pathname === '/dev/oidc/sfi/oauth/v1/authorize', au.pathname);
  check('aucun paramètre PKCE envoyé',
    !au.searchParams.has('code_challenge') && !au.searchParams.has('code_challenge_method'));
  check('scopes du partenaire transmis',
    au.searchParams.get('scope') === 'openid profile email billetterie',
    au.searchParams.get('scope'));
  check('state et nonce présents',
    !!au.searchParams.get('state') && !!au.searchParams.get('nonce'));

  console.log('\n\x1b[1m3. Parcours complet\x1b[0m');
  check('callback → redirection', j.res.status === 302, `HTTP ${j.res.status}`);
  check('destination respectée',
    (j.res.headers.get('location') || '').endsWith('/partner/zzaisc/events'),
    j.res.headers.get('location') || '');
  const who = await get(`${B}/partner/zzaisc/auth/whoami`);
  const w = await who.json();
  check('session ouverte', who.status === 200, `HTTP ${who.status}`);
  check('sujet = matricule AISC', w.subject === 'M1234569', String(w.subject));
  check('courriel repris d\'infoUser', w.email === 'jean.dupont@aisc.test', String(w.email));
  check('nom repris d\'infoUser', w.name === 'Jean DUPONT', String(w.name));

  console.log('\n\x1b[1m4. L\'id_token est nu : le profil vient d\'infoUser\x1b[0m');
  // Rejoue l'échange à la main pour inspecter les jetons bruts.
  const raw = new URLSearchParams();
  for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'scope']) raw.set(k, au.searchParams.get(k) || '');
  const rawAuth = await fetch(`${SFI}/oauth/v1/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: raw
  });
  const rawCode = new URL(rawAuth.headers.get('location')).searchParams.get('code');
  const tokRes = await fetch(`${SFI}/oauth/v1/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'bts-belougas', grant_type: 'authorization_code', code: rawCode })
  });
  const tok = await tokRes.json();
  const idClaims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
  check('id_token sans claim de profil',
    !('email' in idClaims) && !('name' in idClaims) && !('societe' in idClaims),
    Object.keys(idClaims).join(','));
  const infoRes = await fetch(`${SFI}/oauth/v1/infoUser`, {
    headers: { Authorization: `Bearer ${tok.access_token}` }
  });
  const info = await infoRes.json();
  check('infoUser porte les claims billetterie',
    info.matricule_groupe === 'G0042' && info.societe === 'AIRBUS SAS' && info.subvention === 'A');
  check('dates au format JJ/MM/AAAA (non ISO)',
    /^\d{2}\/\d{2}\/\d{4}$/.test(info.birthdate || ''), String(info.birthdate));

  console.log('\n\x1b[1m5. Dialecte du endpoint /token\x1b[0m');
  const formTok = await fetch(`${SFI}/oauth/v1/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: 'bts-belougas', grant_type: 'authorization_code', code: 'x' })
  });
  check('form-urlencoded refusé par l\'IdP (415)', formTok.status === 415,
    `HTTP ${formTok.status} — donc le succès ci-dessus prouve l'envoi en JSON`);
  const pb = await (await fetch(`${SFI}/oauth/v1/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'bts-belougas', grant_type: 'password' })
  })).json();
  check('erreurs au format problem-detail', pb.title === 'unsupported_grant_type' && pb.status === 400,
    JSON.stringify(pb));

  console.log('\n\x1b[1m6. Contrôles de sécurité mis en échec\x1b[0m');
  // Le cookie de transaction doit être VIVANT, sinon le refus viendrait de son
  // absence et ne dirait rien du contrôle de state.
  jar.clear();
  const rLogin = await get(`${B}/partner/zzaisc/auth/login`);
  const auS = new URL(rLogin.headers.get('location'));
  const fS = new URLSearchParams();
  for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'scope']) fS.set(k, auS.searchParams.get(k) || '');
  const rS = await fetch(`${SFI}/oauth/v1/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: fS
  });
  const cbS = new URL(rS.headers.get('location'));
  check('cookie de transaction bien présent', jar.has('bts_oidc_tx'));
  const forged = new URL(cbS); forged.searchParams.set('state', 'forge');
  let r = await get(forged.toString());
  const forgedTxt = await r.text();
  check('state falsifié refusé', r.status === 400 && /state/.test(forgedTxt), forgedTxt.slice(0, 48));

  // Le rejeu se juge chez l'IdP : côté BTS le cookie de transaction est
  // consommé, donc un second callback échouerait de toute façon et ne
  // prouverait rien sur l'usage unique du code.
  const codeOnce = cbS.searchParams.get('code');
  const body1 = { client_id: 'bts-belougas', grant_type: 'authorization_code', code: codeOnce };
  const t1 = await fetch(`${SFI}/oauth/v1/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body1)
  });
  const t2 = await fetch(`${SFI}/oauth/v1/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body1)
  });
  const t2j = await t2.json();
  check('code valable une seule fois',
    t1.status === 200 && t2.status === 400 && t2j.title === 'invalid_grant',
    `1er ${t1.status}, 2e ${t2.status} ${t2j.detail || ''}`);

  const jDeny = await journey('zzaisc', { deny: '1' });
  check('refus de l\'ayant droit → 403', jDeny.res.status === 403,
    (await jDeny.res.text()).slice(0, 60));

  const jSoc = await journey('zzaisc', { societe: 'AUTRE SA' });
  check('société non conforme → 403', jSoc.res.status === 403,
    (await jSoc.res.text()).slice(0, 60));

  const jNonce = await journey('zzaisc', { no_nonce: '1' });
  const nonceTxt = await jNonce.res.text();
  check('id_token sans nonce refusé', jNonce.res.status === 502 && /nonce/.test(nonceTxt),
    nonceTxt.slice(0, 70));

  const jKey = await journey('zzaisc-sanscle');
  const keyTxt = await jKey.res.text();
  check('aucun moyen de vérifier la signature → refus',
    jKey.res.status === 502 && /idTokenPublicKey/.test(keyTxt), keyTxt.slice(0, 90));

  jar.clear();
  const jNext = await journey('zzaisc', {}, '?next=https://evil.example/x');
  check('next externe ramené sur le partenaire',
    (jNext.res.headers.get('location') || '').endsWith('/partner/zzaisc/events'),
    jNext.res.headers.get('location') || '');

  console.log('\n\x1b[1m7. Particularités SFI annexes\x1b[0m');
  const promptNone = await fetch(
    `${SFI}/oauth/v1/authorize?client_id=bts-belougas&response_type=code&state=s&scope=openid`
    + `&prompt=none&redirect_uri=${encodeURIComponent(B + '/partner/zzaisc/auth/callback')}`,
    { redirect: 'manual' }
  );
  check('prompt=none sans session → login_required',
    (promptNone.headers.get('location') || '').includes('error=login_required'));
  const badScope = await (await fetch(
    `${SFI}/oauth/v1/authorize?client_id=bts-belougas&response_type=code&state=s`
    + `&scope=openid+inconnu&redirect_uri=${encodeURIComponent(B + '/x')}`)).json();
  check('scope inconnu refusé', badScope.title === 'invalid_scope', badScope.detail || '');
  const cc = await (await fetch(`${SFI}/oauth/v1/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'bts-belougas', client_secret: 'srv', grant_type: 'client_credentials' })
  })).json();
  check('client_credentials rend un jeton sans id_token',
    !!cc.access_token && !cc.id_token);

  const rTok = await get(`${B}/partner/zzjeton/auth/login`);
  check('partenaire sans OIDC → 404', rTok.status === 404, (await rTok.text()).slice(0, 48));

  console.log('\n\x1b[1m8. Non-régression : profil normalisé inchangé\x1b[0m');
  const stdDisco = await (await fetch(`${B}/dev/oidc/.well-known/openid-configuration`)).json();
  check('découverte standard toujours servie', stdDisco.issuer === `${B}/dev/oidc`);
  check('PKCE toujours annoncé côté standard',
    (stdDisco.code_challenge_methods_supported || []).includes('S256'));

} catch (err) {
  failures++;
  console.error('\n\x1b[31mErreur du harnais :\x1b[0m', err);
} finally {
  srv.close();
  const after = fs.existsSync(REAL_CFG) ? fs.readFileSync(REAL_CFG, 'utf8') : null;
  check('configuration partenaire réelle intacte', after === REAL_BEFORE);
  process.chdir(ROOT);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log(failures === 0
    ? '\n\x1b[32mTous les contrôles passent.\x1b[0m'
    : `\n\x1b[31m${failures} contrôle(s) en échec.\x1b[0m`);
  process.exit(failures ? 1 : 0);
}
