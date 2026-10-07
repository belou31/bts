#!/usr/bin/env node
//
// Parcours OIDC normalisé (découverte, PKCE S256, JWKS) contre le fournisseur
// factice, puis chaque contrôle de sécurité mis en échec volontairement.
//
//   npm run test:oidc
//
// Ne touche AUCUN fichier du dépôt : la configuration partenaire est fabriquée
// dans un répertoire jetable, et le test le vérifie avant de rendre la main.
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.JWT_SECRET = 'secret-de-test-oidc';
process.env.APP_ENV = 'development';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-oidc-'));
fs.mkdirSync(path.join(SANDBOX, 'data', 'customization'), { recursive: true });
const REAL_CFG = path.join(ROOT, 'data', 'customization', 'partners.json');
const REAL_BEFORE = fs.existsSync(REAL_CFG) ? fs.readFileSync(REAL_CFG, 'utf8') : null;
process.chdir(SANDBOX);
const cfgPath = path.join(SANDBOX, 'data', 'customization', 'partners.json');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const srv = app.listen(0);
const B = `http://127.0.0.1:${srv.address().port}`;
process.env.APP_URL = B;

const ok = (b) => (b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ ÉCHEC\x1b[0m');
let failures = 0;
function check(label, pass, detail = '') {
  if (!pass) failures++;
  console.log(`  ${ok(pass)} ${label}${detail ? '  — ' + detail : ''}`);
}

try {
  fs.writeFileSync(cfgPath, JSON.stringify([
    {
      slug: 'zzoidc', name: 'Partenaire OIDC test',
      oidc: {
        issuer: `${B}/dev/oidc`,
        clientId: 'bts-client', clientSecret: 'shhh',
        scopes: ['openid', 'profile', 'email', 'groups'],
        requiredClaim: { claim: 'groups', value: 'abonnes' },
        required: true
      }
    },
    { slug: 'zzjeton', name: 'Partenaire à jeton statique' }
  ], null, 2));

  const stub = (await import(path.join(ROOT, 'src/routes/dev-oidc-stub.routes.js'))).default;
  const partnerAuth = (await import(path.join(ROOT, 'src/routes/partner-auth.routes.js'))).default;
  app.use('/dev/oidc', stub);
  app.use(partnerAuth);

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

  // Ouvre /login, pousse l'écran de l'IdP, revient sur /callback.
  const journey = async (slug, fields = {}, query = '') => {
    jar.clear();
    const r1 = await get(`${B}/partner/${slug}/auth/login${query}`);
    if (r1.status !== 302) return { res: r1 };
    const au = new URL(r1.headers.get('location'));
    const form = new URLSearchParams();
    for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) {
      form.set(k, au.searchParams.get(k) || '');
    }
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const r2 = await fetch(`${B}/dev/oidc/authorize`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
    });
    const cb = r2.headers.get('location');
    return { authorizeUrl: au, cb, res: await get(cb) };
  };

  console.log('\n\x1b[1m1. Découverte\x1b[0m');
  const disco = await (await fetch(`${B}/dev/oidc/.well-known/openid-configuration`)).json();
  check('issuer annoncé = issuer configuré', disco.issuer === `${B}/dev/oidc`);
  check('PKCE S256 annoncé',
    (disco.code_challenge_methods_supported || []).includes('S256'));
  check('JWKS servi', Array.isArray((await (await fetch(disco.jwks_uri)).json()).keys));

  console.log('\n\x1b[1m2. Parcours complet\x1b[0m');
  const j = await journey('zzoidc', { sub: 'user-001', name: 'Camille Durand', email: 'camille@partenaire.test', groups: 'abonnes' }, '?next=/partner/zzoidc/events');
  check('PKCE envoyé', j.authorizeUrl.searchParams.get('code_challenge_method') === 'S256');
  check('callback → redirection', j.res.status === 302, `HTTP ${j.res.status}`);
  check('destination respectée',
    (j.res.headers.get('location') || '').endsWith('/partner/zzoidc/events'));
  const w = await (await get(`${B}/partner/zzoidc/auth/whoami`)).json();
  check('session ouverte', w.authenticated === true && w.via === 'oidc');
  check('identité reprise de l\'id_token',
    w.subject === 'user-001' && w.email === 'camille@partenaire.test', `${w.subject} / ${w.email}`);

  console.log('\n\x1b[1m3. Contrôles de sécurité mis en échec\x1b[0m');
  // Le cookie de transaction doit être VIVANT, sinon le refus viendrait de son
  // absence et ne dirait rien du contrôle de state.
  jar.clear();
  const rLogin = await get(`${B}/partner/zzoidc/auth/login`);
  const au2 = new URL(rLogin.headers.get('location'));
  const f2 = new URLSearchParams();
  for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) f2.set(k, au2.searchParams.get(k) || '');
  f2.set('sub', 'user-001'); f2.set('groups', 'abonnes');
  const cb2 = new URL((await fetch(`${B}/dev/oidc/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: f2
  })).headers.get('location'));
  check('cookie de transaction présent', jar.has('bts_oidc_tx'));
  const forged = new URL(cb2); forged.searchParams.set('state', 'forge');
  const rForged = await get(forged.toString());
  const forgedTxt = await rForged.text();
  check('state falsifié refusé', rForged.status === 400 && /state/.test(forgedTxt), forgedTxt.slice(0, 44));

  // Le rejeu se juge chez l'IdP : côté BTS le cookie de transaction est
  // consommé, donc un second callback échouerait de toute façon.
  const code = cb2.searchParams.get('code');
  const tokBody = new URLSearchParams({
    grant_type: 'authorization_code', code,
    redirect_uri: `${B}/partner/zzoidc/auth/callback`, client_id: 'bts-client',
    code_verifier: 'peu-importe'
  });
  const t1 = await fetch(`${B}/dev/oidc/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: tokBody
  });
  check('vérificateur PKCE erroné refusé', t1.status === 400,
    (await t1.json()).error_description || '');

  const jDeny = await journey('zzoidc', { deny: '1' });
  check('refus de l\'IdP → 403', jDeny.res.status === 403);
  const jClaim = await journey('zzoidc', { sub: 'user-002', groups: 'visiteurs' });
  check('claim requis non tenu → 403', jClaim.res.status === 403,
    (await jClaim.res.text()).slice(0, 48));
  const jNext = await journey('zzoidc', { sub: 'u3', groups: 'abonnes' }, '?next=https://evil.example/x');
  check('next externe ramené sur le partenaire',
    (jNext.res.headers.get('location') || '').endsWith('/partner/zzoidc/events'));
  const rTok = await get(`${B}/partner/zzjeton/auth/login`);
  check('partenaire sans OIDC → 404', rTok.status === 404);
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
