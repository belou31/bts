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
import {
  requestLoginCode, verifyLoginCode, identityFromMember, CODE_TTL_MIN
} from '../services/partner-directory.js';
import { partnerConnection } from '../services/partner-connection.js';

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
  // Un seul mode de connexion par partenaire (services/partner-connection.js) ;
  // les blocs oidc / directory ne sont que des réglages.
  const mode = partnerConnection(cfg);
  if (mode === 'none') {
    // Dire que ce partenaire n'a pas de connexion, plutôt qu'un 404 qui
    // laisserait croire à une faute de frappe.
    res.status(404).send('Ce partenaire n\'utilise pas de connexion (ni OpenID, ni annuaire).');
    return null;
  }
  const oidc = mode === 'openid' ? oidcConfigFor(cfg) : null;
  if (mode === 'openid' && !oidc) {
    res.status(500).send('Connexion OpenID choisie pour ce partenaire, mais son bloc oidc est absent ou incomplet (issuer, clientId).');
    return null;
  }
  return { slug, cfg, oidc, directory: mode === 'directory' };
}

// ── Annuaire local : identifiant + e-mail, puis code reçu par e-mail ────────

const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Écran de connexion de l'annuaire. Adresses ABSOLUES, BASE_PATH compris
// (req.baseUrl) : l'écran du code est la réponse à …/directory/request, et
// une action relative s'y résolvait en …/directory/directory/verify.
function directoryPage(req, res, { cfg, slug, next, step, identifier = '', email = '', error = '', info = '' }) {
  const name = cfg.name || slug;
  const authBase = `${req.baseUrl || ''}/partner/${encodeURIComponent(slug)}/auth`;
  const hidden = (k, v) => `<input type="hidden" name="${k}" value="${escHtml(v)}">`;
  const body = step === 'code'
    ? `<form method="post" action="${authBase}/directory/verify">
        ${hidden('next', next)}${hidden('identifier', identifier)}${hidden('email', email)}
        <label>Code reçu par e-mail<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required autofocus></label>
        <button type="submit">Se connecter</button>
      </form>
      <form method="post" action="${authBase}/directory/request" class="secondary">
        ${hidden('next', next)}${hidden('identifier', identifier)}${hidden('email', email)}
        <button type="submit">Renvoyer un code</button>
      </form>
      <p class="muted"><a href="${authBase}/login?next=${encodeURIComponent(next)}">Changer d'identifiant ou d'e-mail</a></p>`
    : `<form method="post" action="${authBase}/directory/request">
        ${hidden('next', next)}
        <label>Identifiant<input name="identifier" value="${escHtml(identifier)}" autocomplete="username" required autofocus></label>
        <label>Adresse e-mail<input name="email" type="email" value="${escHtml(email)}" autocomplete="email" required></label>
        <button type="submit">Recevoir un code</button>
      </form>`;
  res.status(error ? 400 : 200).type('html').send(`<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(name)} — connexion</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f14;color:#e8eef5}
main{max-width:26rem;margin:4rem auto;padding:1.5rem;background:#121a22;border:1px solid #213040;border-radius:12px}
h1{font-size:1.15rem;margin:0 0 .3rem}p{line-height:1.4}.muted{color:#a6b3c2;font-size:.9rem}
label{display:block;margin:.9rem 0 .2rem;font-size:.9rem}
input{display:block;width:100%;box-sizing:border-box;margin-top:.3rem;padding:.55rem;border-radius:8px;border:1px solid #213040;background:#0b0f14;color:#e8eef5;font-size:1rem}
button{margin-top:1rem;padding:.6rem 1rem;border-radius:10px;border:1px solid #213040;background:#0b0f14;color:#e8eef5;font-weight:700;cursor:pointer}
button:hover{background:#18222d}.secondary button{font-weight:400;color:#a6b3c2}
.err{color:#ef4444}.info{color:#10b981}a{color:#3ba0ff}
</style>
<main>
<h1>${escHtml(name)}</h1>
<p class="muted">${step === 'code'
    ? `Si l'identifiant et l'adresse correspondent, un code à 6 chiffres vient d'être envoyé à <strong>${escHtml(email)}</strong>. Il est valable ${CODE_TTL_MIN} minutes.`
    : 'Saisissez votre identifiant et l\'une des adresses e-mail que votre organisme a déclarées pour vous. Vous recevrez un code de connexion.'}</p>
${error ? `<p class="err">${escHtml(error)}</p>` : ''}${info ? `<p class="info">${escHtml(info)}</p>` : ''}
${body}
</main></html>`);
}

router.post('/partner/:partnerSlug/auth/directory/request', async (req, res) => {
  const ctx = resolvePartner(req, res);
  if (!ctx) return;
  const { slug, cfg } = ctx;
  if (!ctx.directory) return res.status(404).send('Annuaire non activé pour ce partenaire.');
  const next = safeNext(slug, req.body?.next);
  const identifier = String(req.body?.identifier || '').trim().slice(0, 100);
  const email = String(req.body?.email || '').trim().slice(0, 200);
  if (!identifier || !email) {
    return directoryPage(req, res, { cfg, slug, next, step: 'request', identifier, email, error: 'Identifiant et adresse e-mail sont requis.' });
  }
  try {
    const r = await requestLoginCode({ partnerSlug: slug, partnerName: cfg.name, identifier, email });
    // Même écran que l'envoi ait eu lieu ou non : ne rien révéler de l'annuaire.
    if (!r.sent) console.warn(`[partner-directory] ${slug} : pas de code (${r.reason}) pour l'identifiant saisi`);
  } catch (err) {
    console.error('[partner-directory/request]', err);
    return directoryPage(req, res, { cfg, slug, next, step: 'request', identifier, email, error: 'Envoi du code impossible pour le moment. Réessayez dans un instant.' });
  }
  return directoryPage(req, res, { cfg, slug, next, step: 'code', identifier, email });
});

router.post('/partner/:partnerSlug/auth/directory/verify', async (req, res) => {
  const ctx = resolvePartner(req, res);
  if (!ctx) return;
  const { slug, cfg } = ctx;
  if (!ctx.directory) return res.status(404).send('Annuaire non activé pour ce partenaire.');
  const next = safeNext(slug, req.body?.next);
  const identifier = String(req.body?.identifier || '').trim().slice(0, 100);
  const email = String(req.body?.email || '').trim().slice(0, 200);
  try {
    const member = await verifyLoginCode({ partnerSlug: slug, identifier, email, code: req.body?.code });
    if (!member) {
      return directoryPage(req, res, {
        cfg, slug, next, step: 'code', identifier, email,
        error: 'Code invalide ou expiré. Vérifiez-le, ou demandez-en un nouveau.'
      });
    }
    issueSession(res, { slug, identity: identityFromMember(member, email), via: 'directory' });
    return res.redirect(`${appBase()}${next}`);
  } catch (err) {
    console.error('[partner-directory/verify]', err);
    return directoryPage(req, res, { cfg, slug, next, step: 'code', identifier, email, error: 'Vérification impossible pour le moment. Réessayez.' });
  }
});

router.get('/partner/:partnerSlug/auth/login', async (req, res) => {
  const ctx = resolvePartner(req, res);
  if (!ctx) return;
  const { slug, oidc } = ctx;

  // Le retour de l'IdP (ou la fin de connexion par annuaire) arrive sur l'hôte
  // d'APP_URL : les cookies doivent y être posés. Une connexion lancée sur un
  // autre nom (127.0.0.1 au lieu de localhost…) y est d'abord renvoyée. Une
  // seule fois (_h=1) : derrière un
  // mandataire qui ne transmet pas l'en-tête Host, on ne boucle pas, le
  // callback expliquera le problème.
  let appOrigin = '';
  try { appOrigin = new URL(appBase()).origin; } catch { /* APP_URL vide */ }
  const appHost = appOrigin ? new URL(appOrigin).host : '';
  if (appHost && req.get('host') && req.get('host') !== appHost && req.query._h !== '1') {
    const sep = req.originalUrl.includes('?') ? '&' : '?';
    return res.redirect(`${appOrigin}${req.originalUrl}${sep}_h=1`);
  }

  // Annuaire local : écran identifiant + e-mail, pas de détour par un IdP.
  // Après le recadrage d'hôte ci-dessus : la session est posée sur l'hôte de
  // la page, puis on redirige vers APP_URL — les deux doivent coïncider.
  if (ctx.directory) {
    return directoryPage(req, res, { cfg: ctx.cfg, slug, next: safeNext(slug, req.query.next), step: 'request' });
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
  if (!oidc) return res.status(404).send('Ce partenaire n\'utilise pas l\'authentification OpenID.');

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
