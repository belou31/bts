// stub_oidc/server.js
// Standalone OpenID Connect / OAuth 2.0 identity-provider stub for local
// development — same spirit as stub_sumup / stub_mollie / stub_helloasso.
//
//   npm run oidc:stub
//
// Two profiles on one server (see stub_oidc/idp.js):
//   standard  http://127.0.0.1:3016          (discovery, PKCE, JWKS)
//   sfi       http://127.0.0.1:3016/sfi      (AISC / Castelis preprod dialect)
// Dashboard at / : default scenario, test identities, partners.json snippets,
// recent calls.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createIdp, SCENARIOS, esc } from './idp.js';

const HOST = process.env.OIDC_STUB_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.OIDC_STUB_PORT || 3016);
// URL publique annoncée (émetteur) ; à surcharger si le stub est joint par un
// autre nom que HOST:PORT (conteneur, proxy).
const PUBLIC_URL = (process.env.OIDC_STUB_PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/+$/, '');
const DIR = path.dirname(fileURLToPath(import.meta.url));
// Clé de signature conservée d'un lancement à l'autre : une clé publique
// collée dans partners.json reste valable après redémarrage du stub.
const KEY_FILE = process.env.OIDC_STUB_KEY_FILE || path.join(DIR, '.keys', 'signing-key.pem');

if (String(process.env.APP_ENV || '').toLowerCase() === 'production') {
  console.error('[oidc-stub] refusé : APP_ENV=production. Ce stub délivre une identité à quiconque la demande.');
  process.exit(1);
}

const idp = createIdp({ baseUrl: () => PUBLIC_URL, keyFile: KEY_FILE });
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.post('/default-scenario', (req, res) => {
  const s = String(req.body?.scenario || '');
  if (SCENARIOS[s]) idp.state.scenario = s;
  res.redirect('/');
});

app.post('/identity/:profile', (req, res) => {
  const target = idp.state.identities[req.params.profile];
  if (target) {
    for (const k of Object.keys(target)) {
      if (req.body?.[k] !== undefined) target[k] = String(req.body[k]).trim();
    }
  }
  res.redirect('/');
});

app.get('/events.json', (_req, res) => res.json(idp.state.events));

app.get('/', (_req, res) => {
  const { state } = idp;
  const sfi = idp.sfiBase();
  const pem = idp.keys().publicPem;

  const radios = Object.entries(SCENARIOS).map(([k, label]) =>
    `<label class="radio"><input type="radio" name="scenario" value="${k}"${state.scenario === k ? ' checked' : ''}> <code>${k}</code> — ${esc(label)}</label>`
  ).join('');
  const identityForm = (profile) => {
    const id = state.identities[profile];
    return `<form method="post" action="/identity/${profile}" class="grid">
      ${Object.entries(id).map(([k, v]) => `<label>${esc(k)}<input name="${k}" value="${esc(v)}"></label>`).join('')}
      <button type="submit">Enregistrer</button></form>`;
  };
  const standardSnippet = JSON.stringify({
    issuer: PUBLIC_URL, clientId: 'bts-dev', clientSecret: 'dev-secret',
    scopes: ['openid', 'profile', 'email', 'groups']
  }, null, 2);
  const sfiSnippet = JSON.stringify({
    issuer: `${sfi}/`, clientId: 'belouga', clientSecret: 'dev-secret',
    endpoints: {
      authorization: `${sfi}/oauth/v1/authorize`,
      token: `${sfi}/oauth/v1/token`,
      userinfo: `${sfi}/oauth/v1/infoUser`,
      jwks: `${PUBLIC_URL}/jwks.json`
    },
    scopes: ['openid', 'partenaires'],
    pkce: false, tokenRequest: 'json', clientAuth: 'body', fetchUserInfo: true,
    identity: {
      identifier: 'sub', firstName: 'given_name', lastName: 'family_name', email: 'email',
      attributes: { beneficiaries: { sum: [1, 'conjoint', 'autres_ad'] } }
    }
  }, null, 2);
  const events = state.events.map(e =>
    `<tr><td>${esc(e.at.slice(11, 19))}</td><td>${esc(e.profile)}</td><td>${esc(e.endpoint)}</td><td>${esc(e.detail)}</td></tr>`
  ).join('') || '<tr><td colspan="4" class="muted">Aucun appel pour l\'instant.</td></tr>';

  res.type('html').send(`<!doctype html><html lang="fr"><meta charset="utf-8">
<title>OIDC stub</title>
<style>
body{font-family:system-ui;margin:0;background:#f4f6f9;color:#1d2733}
main{max-width:64rem;margin:0 auto;padding:1.5rem}
section{background:#fff;border:1px solid #dde3ea;border-radius:10px;padding:1rem 1.2rem;margin-bottom:1rem}
h1{font-size:1.3rem}h2{font-size:1rem;margin-top:0}
.muted{color:#667;font-size:.85rem}code{background:#eef2f6;padding:0 .25rem;border-radius:4px}
.radio{display:block;margin:.25rem 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(11rem,1fr));gap:.5rem;align-items:end}
.grid label{font-size:.8rem}.grid input{width:100%;box-sizing:border-box;padding:.3rem}
pre{background:#0f1720;color:#dbe5ef;padding:.8rem;border-radius:8px;overflow:auto;font-size:.8rem}
table{border-collapse:collapse;width:100%;font-size:.85rem}td{border-top:1px solid #e5e9ef;padding:.3rem}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:1rem}@media(max-width:52rem){.cols{grid-template-columns:1fr}}
</style>
<main>
<h1>OIDC stub — fournisseur d'identité de test</h1>
<p class="muted">Délivre une identité à quiconque la demande : développement uniquement.
Clé de signature <code>${esc(idp.keys().kid)}</code> conservée dans <code>${esc(path.relative(process.cwd(), KEY_FILE))}</code>.</p>

<section><h2>Scénario par défaut</h2>
<form method="post" action="/default-scenario" id="sc">${radios}</form>
<p class="muted">Appliqué à la prochaine connexion. En <code>manual</code>, l'écran de connexion permet aussi de choisir le scénario pour une seule connexion.</p>
</section>

<div class="cols">
<section><h2>Identité — profil standard</h2>${identityForm('standard')}</section>
<section><h2>Identité — profil SFI (AISC)</h2>${identityForm('sfi')}
<p class="muted"><code>autres_ad</code> = nombre d'enfants (0 à 9) ; <code>conjoint</code> 1/0.</p></section>
</div>

<section><h2>Configurer un partenaire BTS (bloc <code>oidc</code> de partners.json)</h2>
<p class="muted">Puis activer la connexion : <code>"connection": "openid"</code> dans l'entrée du partenaire (console : Set Partner Connection).</p>
<div class="cols">
<div><p><strong>Standard</strong> — découverte sur <code>${esc(PUBLIC_URL)}/.well-known/openid-configuration</code></p><pre>${esc(standardSnippet)}</pre></div>
<div><p><strong>SFI</strong> — ni découverte ni JWKS chez le vrai ; ici <code>endpoints.jwks</code> évite de recopier la clé.</p><pre>${esc(sfiSnippet)}</pre></div>
</div>
<details><summary>Clé publique PEM (pour <code>idTokenPublicKey</code>, comme en préproduction)</summary><pre>${esc(pem)}</pre>
<p class="muted">Aussi servie sur <code>${esc(PUBLIC_URL)}/keys/public.pem</code>.</p></details>
</section>

<section><h2>Derniers appels</h2>
<table><tr><th align="left">Heure</th><th align="left">Profil</th><th align="left">Endpoint</th><th align="left">Détail</th></tr>${events}</table>
<p class="muted"><a href="/">Rafraîchir</a> · <a href="/events.json">events.json</a></p>
</section>
</main>
<script>document.querySelectorAll('#sc input').forEach(r => r.addEventListener('change', () => r.form.submit()));</script>
</html>`);
});

app.use(idp.router);

app.listen(PORT, HOST, () => {
  idp.keys();
  console.log(`OIDC stub sur ${PUBLIC_URL}`);
  console.log(`  standard : ${PUBLIC_URL}/.well-known/openid-configuration`);
  console.log(`  sfi      : ${PUBLIC_URL}/sfi/oauth/v1/{authorize,token,infoUser}`);
  console.log(`  tableau de bord : ${PUBLIC_URL}/`);
});
