#!/usr/bin/env node
//
// Annuaire local d'un partenaire (services/partner-directory.js) : import CSV,
// connexion identifiant + e-mail + code, session, accès.
//
//   npm run test:partner-directory
//
// Utilise la base de MONGO_URI (.env) avec un partenaire jetable, dont les
// données sont effacées à la fin. Configuration partenaire et courriels
// (EMAIL_STUB) dans un répertoire temporaire : partners.json réel intact.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dotenv = (await import('dotenv')).default;
dotenv.config({ path: path.join(ROOT, '.env') });
process.env.JWT_SECRET = 'secret-de-test-annuaire';
process.env.EMAIL_STUB = 'true';
process.env.APP_ENV = 'development';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-directory-'));
fs.mkdirSync(path.join(SANDBOX, 'data', 'customization'), { recursive: true });
const REAL_CFG = path.join(ROOT, 'data', 'customization', 'partners.json');
const REAL_BEFORE = fs.existsSync(REAL_CFG) ? fs.readFileSync(REAL_CFG, 'utf8') : null;
process.chdir(SANDBOX);

const SLUG = `zz-directory-${Date.now().toString(36)}`;
fs.writeFileSync(path.join(SANDBOX, 'data', 'customization', 'partners.json'), JSON.stringify([
  { slug: SLUG, name: 'Annuaire test', paymentMode: 'psp', directory: { enabled: true }, admin: { user: 'adm', pass: 'pw' } },
  { slug: `${SLUG}-off`, name: 'Sans annuaire' }
], null, 2));

const ok = (b) => (b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ ÉCHEC\x1b[0m');
let failures = 0;
function check(label, pass, detail = '') {
  if (!pass) failures++;
  console.log(`  ${ok(pass)} ${label}${detail ? '  — ' + detail : ''}`);
}

const mongoose = (await import('mongoose')).default;
const express = (await import('express')).default;
await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
const { PartnerMember } = await import(path.join(ROOT, 'src/models/PartnerMember.js'));
const { PartnerLoginCode } = await import(path.join(ROOT, 'src/models/PartnerLoginCode.js'));
const D = await import(path.join(ROOT, 'src/services/partner-directory.js'));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const srv = app.listen(0);
const B = `http://127.0.0.1:${srv.address().port}`;
process.env.APP_URL = B;
const partnerAuth = (await import(path.join(ROOT, 'src/routes/partner-auth.routes.js'))).default;
const { adminRouter } = await import(path.join(ROOT, 'src/routes/partner.js'));
const { checkPartnerAccess } = await import(path.join(ROOT, 'src/services/partner-access.js'));
const { getPartnerConfig } = await import(path.join(ROOT, 'src/config/partners.js'));
app.use(partnerAuth);
app.use('/partner', adminRouter);
// Même routeur sous un préfixe, comme BASE_PATH=/bts en intégration.
app.use('/bts', partnerAuth);

const OUTBOX = path.join(SANDBOX, 'data', 'outputs', 'outbox');
const mails = () => (fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX).sort() : []);
const lastCode = () => {
  const f = mails().at(-1);
  return f ? (fs.readFileSync(path.join(OUTBOX, f), 'utf8').match(/letter-spacing:6px">(\d{6})</) || [])[1] : null;
};
const ADMIN = { Authorization: 'Basic ' + Buffer.from('adm:pw').toString('base64') };
const form = (o) => new URLSearchParams(o);
const post = (url, body, extra = {}) => fetch(`${B}${url}`, { method: 'POST', redirect: 'manual', body, ...extra });

// Famille : F2 et F3 (dont la casse diffère) se rattachent à F1 ; G1 se
// désigne lui-même, ce qui ne compte pas.
const FAMILY = `identifier,redirect,lastName,firstName,email,beneficiaries,extraPublic
F1,,DURAND,Alice,alice@example.com,2,
F2,f1,DURAND,Hugo,hugo@example.com,1,
F3,F1,DURAND,Inès,parents.durand@example.com,1,1
G1,G1,MOREAU,Paul,paul@example.com,1,
`;

const CSV = `identifier,lastName,firstName,email,beneficiaries
A123456,DUPONT,Camille,camille.dupont@example.com,4
A123456,DUPONT,Camille,C.Dupont@Perso.example,4
B987654,MARTIN,Léo,leo.martin@example.com,2
`;

try {
  console.log('\n\x1b[1m1. Lecture du CSV\x1b[0m');
  let p = D.parseDirectoryCsv(CSV);
  check('2 identifiants, 3 adresses', p.members.length === 2 && p.members[0].emails.length === 2 && !p.errors.length);
  check('adresse ramenée en minuscules', p.members[0].emails.includes('c.dupont@perso.example'));
  p = D.parseDirectoryCsv(CSV.replace(/,/g, ';'));
  check('séparateur « ; » accepté', p.members.length === 2 && !p.errors.length);
  p = D.parseDirectoryCsv('identifier,lastName,firstName,email,beneficiaries\n"A1","DE LA ""TOUR""",Ana,ana@x.fr,1\n');
  check('champs entre guillemets', p.members[0]?.lastName === 'DE LA "TOUR"', p.members[0]?.lastName);
  p = D.parseDirectoryCsv(CSV + 'A123456,DUPONT,Camille,autre@example.com,5\n');
  check('lignes contradictoires → identifiant écarté', p.members.length === 1 && p.errors.some(e => /beneficiaries/.test(e.reason)), JSON.stringify(p.errors[0]));
  p = D.parseDirectoryCsv('identifier,lastName,firstName,email,beneficiaries,extraPublic\nA1,X,Y,a@b.fr,3,2\nA2,X,Z,c@d.fr,1,\n');
  check('extraPublic : lu (2), vide → null', p.members[0]?.extraPublic === 2 && p.members[1]?.extraPublic === null && !p.errors.length);
  p = D.parseDirectoryCsv('identifier,lastName,firstName,email,beneficiaries,extraPublic\nA1,X,Y,a@b.fr,3,-1\nA2,X,Y,c@d.fr,1,2\nA2,X,Y,e@f.fr,1,3\n');
  check('extraPublic : négatif refusé, lignes contradictoires écartées',
    p.errors.some(e => /extraPublic doit/.test(e.reason)) && p.errors.some(e => /extraPublic/.test(e.reason) && /diffère/.test(e.reason)), p.errors.map(e => e.reason).join(' | '));
  check('sans colonne extraPublic → null', D.parseDirectoryCsv(CSV).members.every(m => m.extraPublic === null));
  check('session : extraPublic transmis', D.identityFromMember({ identifier: 'A', emails: ['a@b.fr'], beneficiaries: 3, extraPublic: 2 }, 'a@b.fr').attributes.extraPublic === 2);
  p = D.parseDirectoryCsv('identifier,nom,email\nA,B,c@d.fr\n');
  check('colonnes manquantes → refus', p.errors.length === 1 && /colonnes manquantes/.test(p.errors[0].reason));
  p = D.parseDirectoryCsv('identifier,lastName,firstName,email,beneficiaries\nA1,X,Y,pas-un-email,1\nA2,X,Y,a@b.fr,-1\n');
  check('e-mail et nombre de places invalides signalés', p.errors.length === 2, p.errors.map(e => e.reason).join(' | '));
  p = D.parseDirectoryCsv('identifier,lastName,firstName,email,beneficiaries,extraPublic\nZ1,X,Y,z@b.fr,0,0\n');
  check('beneficiaries 0 et extraPublic 0 : importés (connectable, sans place)', !p.errors.length && p.members[0]?.beneficiaries === 0 && p.members[0]?.extraPublic === 0, JSON.stringify(p));
  p = D.parseDirectoryCsv(FAMILY);
  check('redirect : lu, casse de la fiche visée, vide ou soi-même → null', !p.errors.length
    && p.members.find(m => m.identifier === 'F2')?.redirect === 'F1'
    && p.members.find(m => m.identifier === 'F3')?.redirect === 'F1'
    && p.members.find(m => m.identifier === 'F1')?.redirect === null
    && p.members.find(m => m.identifier === 'G1')?.redirect === null, JSON.stringify(p));
  p = D.parseDirectoryCsv('identifier,redirect,lastName,firstName,email,beneficiaries\nA1,ZZ,X,Y,a@b.fr,1\nB1,,X,Y,b@b.fr,1\nB2,B1,X,Y,c@b.fr,1\nB3,B2,X,Y,d@b.fr,1\n');
  check('redirect : cible absente ou chaîne → ligne écartée',
    p.members.map(m => m.identifier).join() === 'B1,B2'
    && p.errors.some(e => e.identifier === 'A1' && /absent/.test(e.reason))
    && p.errors.some(e => e.identifier === 'B3' && /redirige lui-même/.test(e.reason)), p.errors.map(e => e.reason).join(' | '));
  p = D.parseDirectoryCsv('identifier,redirect,lastName,firstName,email,beneficiaries\nB1,,X,Y,b@b.fr,1\nB2,B1,X,Y,c@b.fr,1\nB2,,X,Y,d@b.fr,1\n');
  check('redirect : lignes contradictoires → identifiant écarté', p.members.length === 1 && p.errors.some(e => /redirect/.test(e.reason) && /diffère/.test(e.reason)));
  check('session : quota de la famille additionné', D.identityFromMember({ identifier: 'F1', beneficiaries: 2, extraPublic: null },
    'x@y.fr', { group: [{ beneficiaries: 2, extraPublic: null }, { beneficiaries: 1, extraPublic: null }], loginIdentifier: 'F2' }).attributes
    .beneficiaries === 3);

  console.log('\n\x1b[1m2. Pages d\'administration\x1b[0m');
  let r = await fetch(`${B}/partner/${SLUG}/admin?format=html`, { redirect: 'manual' });
  check('ancienne adresse /admin → /admin/orders (requête conservée)', r.status === 301 && r.headers.get('location').endsWith(`/partner/${SLUG}/admin/orders?format=html`), r.headers.get('location'));
  r = await fetch(`${B}/partner/${SLUG}/admin/directory`);
  check('annuaire sans identifiants admin → 401', r.status === 401);
  r = await post(`/partner/${SLUG}/admin/directory`, CSV + 'A123456,DUPONT,Camille,autre@example.com,5\n', { headers: { ...ADMIN, 'Content-Type': 'text/csv' } });
  let j = await r.json();
  check('import avec une erreur → refusé en bloc', r.status === 400 && j.errors?.length >= 1 && await PartnerMember.countDocuments({ partnerSlug: SLUG }) === 0);
  r = await post(`/partner/${SLUG}/admin/directory`, 'identifier,lastName,firstName,email,beneficiaries\n', { headers: { ...ADMIN, 'Content-Type': 'text/csv' } });
  check('import vide → refusé', r.status === 400);
  r = await post(`/partner/${SLUG}/admin/directory`, CSV, { headers: { ...ADMIN, 'Content-Type': 'text/csv' } });
  j = await r.json();
  check('import valide → 2 ayants droit', r.status === 200 && j.imported === 2 && j.removed === 0, JSON.stringify(j));
  r = await post(`/partner/${SLUG}/admin/directory`, 'identifier,lastName,firstName,email,beneficiaries\nA123456,DUPONT,Camille,camille.dupont@example.com,4\n', { headers: { ...ADMIN, 'Content-Type': 'text/csv' } });
  j = await r.json();
  check('réimport → remplace (1 retiré)', j.imported === 1 && j.removed === 1, JSON.stringify(j));
  await post(`/partner/${SLUG}/admin/directory`, CSV, { headers: { ...ADMIN, 'Content-Type': 'text/csv' } });
  const html = await (await fetch(`${B}/partner/${SLUG}/admin/directory`, { headers: ADMIN })).text();
  check('page : statut et compteurs', /annuaire activée/.test(html)
    && /<strong>2<\/strong> ayant\(s\) droit/.test(html) && /<strong>3<\/strong> adresse\(s\)/.test(html));
  check('page : titre au nom du partenaire', /<title>Annuaire — Annuaire test<\/title>/.test(html));
  const csvOut = await (await fetch(`${B}/partner/${SLUG}/admin/directory.csv`, { headers: ADMIN })).text();
  check('export : une ligne par adresse, réimportable', csvOut.trim().split('\n').length === 4 && D.parseDirectoryCsv(csvOut).members.length === 2);

  console.log('\n\x1b[1m3. Connexion identifiant + e-mail + code\x1b[0m');
  r = await fetch(`${B}/partner/${SLUG}/auth/login?next=/partner/${SLUG}/events`);
  const loginHtml = await r.text();
  check('écran de connexion de l\'annuaire', r.status === 200 && /name="identifier"/.test(loginHtml) && /name="email"/.test(loginHtml));
  const before = mails().length;
  r = await post(`/partner/${SLUG}/auth/directory/request`, form({ identifier: 'A123456', email: 'inconnu@example.com', next: `/partner/${SLUG}/events` }));
  const noMatch = await r.text();
  check('e-mail étranger → même écran, aucun code envoyé', r.status === 200 && /Code reçu par e-mail/.test(noMatch) && mails().length === before);
  r = await post(`/partner/${SLUG}/auth/directory/request`, form({ identifier: 'ZZZ', email: 'camille.dupont@example.com', next: '/' }));
  check('identifiant inconnu → même écran, aucun code', /Code reçu par e-mail/.test(await r.text()) && mails().length === before);
  r = await post(`/partner/${SLUG}/auth/directory/request`, form({ identifier: 'a123456', email: 'C.DUPONT@perso.example', next: `/partner/${SLUG}/events` }));
  await r.text();
  const code = lastCode();
  check('identifiant (casse indifférente) + 2e adresse → code envoyé', mails().length === before + 1 && /^\d{6}$/.test(code || ''), code);
  const wrong = code === '000000' ? '111111' : '000000';
  r = await post(`/partner/${SLUG}/auth/directory/verify`, form({ identifier: 'A123456', email: 'c.dupont@perso.example', code: wrong, next: `/partner/${SLUG}/events` }));
  check('mauvais code → refus', r.status === 400 && /Code invalide/.test(await r.text()));
  r = await post(`/partner/${SLUG}/auth/directory/verify`, form({ identifier: 'A123456', email: 'c.dupont@perso.example', code, next: `/partner/${SLUG}/events` }));
  const cookie = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  check('bon code → session et retour à la page demandée', r.status === 302 && r.headers.get('location').endsWith(`/partner/${SLUG}/events`) && cookie.includes(`bts_partner_${SLUG}`));
  const who = await (await fetch(`${B}/partner/${SLUG}/auth/whoami`, { headers: { Cookie: cookie } })).json();
  check('session : identifiant, e-mail saisi, places', who.identifier === 'A123456' && who.email === 'c.dupont@perso.example'
    && who.firstName === 'Camille' && who.attributes?.beneficiaries === 4 && who.via === 'directory', JSON.stringify(who));
  r = await post(`/partner/${SLUG}/auth/directory/verify`, form({ identifier: 'A123456', email: 'c.dupont@perso.example', code, next: '/' }));
  check('code à usage unique', r.status === 400);

  console.log('\n\x1b[1m3b. Parcours navigateur : on suit les formulaires\x1b[0m');
  // Comme un navigateur : l'action de chaque formulaire est résolue par
  // rapport à l'URL de la page qui le contient — c'est ce qui cassait
  // (…/directory/directory/verify) quand les actions étaient relatives.
  const actionOf = (html, field) => {
    const f = [...html.matchAll(/<form[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/g)].find(m => m[2].includes(`name="${field}"`));
    return f ? f[1] : null;
  };
  for (const prefix of ['', '/bts']) {
    await PartnerLoginCode.deleteMany({ partnerSlug: SLUG, identifier: 'A123456' });
    const loginUrl = `${B}${prefix}/partner/${SLUG}/auth/login?next=/partner/${SLUG}/events`;
    const page1 = await (await fetch(loginUrl)).text();
    const reqUrl = new URL(actionOf(page1, 'identifier'), loginUrl).href;
    check(`${prefix || '(racine)'} : écran 1 → …/auth/directory/request`, reqUrl === `${B}${prefix}/partner/${SLUG}/auth/directory/request`, reqUrl);
    const page2 = await (await post(reqUrl.slice(B.length), form({ identifier: 'A123456', email: 'camille.dupont@example.com', next: `/partner/${SLUG}/events` }))).text();
    const verifyUrl = new URL(actionOf(page2, 'code'), reqUrl).href;
    check(`${prefix || '(racine)'} : écran du code → …/auth/directory/verify`, verifyUrl === `${B}${prefix}/partner/${SLUG}/auth/directory/verify`, verifyUrl);
    r = await post(verifyUrl.slice(B.length), form({ identifier: 'A123456', email: 'camille.dupont@example.com', code: lastCode(), next: `/partner/${SLUG}/events` }));
    check(`${prefix || '(racine)'} : code saisi → connecté`, r.status === 302 && (r.headers.getSetCookie?.() || []).some(c => c.startsWith(`bts_partner_${SLUG}=`)));
  }
  // Écran ouvert sur un autre nom d'hôte qu'APP_URL (localhost ↔ 127.0.0.1) :
  // la session serait posée sur cet hôte puis la redirection finale irait
  // vers APP_URL, sans cookie. On est d'abord renvoyé sur l'hôte d'APP_URL.
  const otherHost = B.replace('127.0.0.1', 'localhost');
  r = await fetch(`${otherHost}/partner/${SLUG}/auth/login?next=/partner/${SLUG}/events`, { redirect: 'manual' });
  check('écran ouvert sur un autre hôte → renvoyé sur celui d\'APP_URL', r.status === 302
    && r.headers.get('location').startsWith(`${B}/partner/${SLUG}/auth/login?`), r.headers.get('location'));
  await PartnerLoginCode.deleteMany({ partnerSlug: SLUG, identifier: 'A123456' });

  console.log('\n\x1b[1m4. Limites\x1b[0m');
  await post(`/partner/${SLUG}/auth/directory/request`, form({ identifier: 'B987654', email: 'leo.martin@example.com', next: '/' })).then(x => x.text());
  const leoCode = lastCode();
  for (let i = 0; i < D.MAX_CODE_ATTEMPTS; i++) {
    await post(`/partner/${SLUG}/auth/directory/verify`, form({ identifier: 'B987654', email: 'leo.martin@example.com', code: leoCode === '000000' ? '111111' : '000000', next: '/' })).then(x => x.text());
  }
  r = await post(`/partner/${SLUG}/auth/directory/verify`, form({ identifier: 'B987654', email: 'leo.martin@example.com', code: leoCode, next: '/' }));
  check(`après ${D.MAX_CODE_ATTEMPTS} essais, même le bon code est refusé`, r.status === 400);
  const n0 = mails().length;
  for (let i = 0; i < D.MAX_CODES_PER_WINDOW + 1; i++) {
    await post(`/partner/${SLUG}/auth/directory/request`, form({ identifier: 'B987654', email: 'leo.martin@example.com', next: '/' })).then(x => x.text());
  }
  check(`au plus ${D.MAX_CODES_PER_WINDOW} codes par ${D.CODE_WINDOW_MIN} min`, mails().length - n0 === D.MAX_CODES_PER_WINDOW - 1, `${mails().length - n0} envoyé(s) (1 déjà émis)`);
  const stored = await PartnerLoginCode.findOne({ partnerSlug: SLUG }).lean();
  check('code jamais conservé en clair', stored && !Object.values(stored).includes(code) && /^[0-9a-f]{64}$/.test(stored.codeHash));

  console.log('\n\x1b[1m4b. Familles (redirect)\x1b[0m');
  r = await post(`/partner/${SLUG}/admin/directory`, FAMILY, { headers: { ...ADMIN, 'Content-Type': 'text/csv' } });
  j = await r.json();
  check('import d\'une famille', r.status === 200 && j.imported === 4, JSON.stringify(j));
  const famHtml = await (await fetch(`${B}/partner/${SLUG}/admin/directory`, { headers: ADMIN })).text();
  check('page : compteur des redirigés', /<strong>2<\/strong> redirigé\(s\)/.test(famHtml));
  const famCsv = await (await fetch(`${B}/partner/${SLUG}/admin/directory.csv`, { headers: ADMIN })).text();
  check('export : colonne redirect, réimportable', famCsv.startsWith('identifier,redirect,')
    && D.parseDirectoryCsv(famCsv).members.find(m => m.identifier === 'F2')?.redirect === 'F1');
  const loginAs = async (identifier, email) => {
    await post(`/partner/${SLUG}/auth/directory/request`, form({ identifier, email, next: '/' })).then(x => x.text());
    const c = lastCode();
    const res = await post(`/partner/${SLUG}/auth/directory/verify`, form({ identifier, email, code: c, next: '/' }));
    const ck = (res.headers.getSetCookie?.() || []).map(x => x.split(';')[0]).join('; ');
    return (await fetch(`${B}/partner/${SLUG}/auth/whoami`, { headers: { Cookie: ck } })).json();
  };
  let w = await loginAs('F3', 'parents.durand@example.com');
  check('connexion par F3 → session de F1, e-mail de connexion, quota famille 4, extra 1',
    w.identifier === 'F1' && w.firstName === 'Alice' && w.email === 'parents.durand@example.com'
    && w.attributes?.beneficiaries === 4 && w.attributes?.extraPublic === 1 && w.attributes?.loginIdentifier === 'F3', JSON.stringify(w));
  w = await loginAs('F1', 'alice@example.com');
  check('connexion par F1 → même quota de famille, sans loginIdentifier',
    w.identifier === 'F1' && w.attributes?.beneficiaries === 4 && !('loginIdentifier' in (w.attributes || {})), JSON.stringify(w));
  check('F3 ne peut pas se connecter avec l\'adresse de F1', (await D.requestLoginCode({ partnerSlug: SLUG, identifier: 'F3', email: 'alice@example.com' })).sent === false);
  w = await loginAs('G1', 'paul@example.com');
  check('redirect vers soi-même → fiche normale', w.identifier === 'G1' && w.attributes?.beneficiaries === 1, JSON.stringify(w));

  console.log('\n\x1b[1m5. Accès aux pages du partenaire\x1b[0m');
  const cfg = getPartnerConfig(SLUG);
  const fakeReq = (c) => ({ headers: { cookie: c }, query: {}, params: { partnerSlug: SLUG }, get: () => '' });
  check('annuaire activé → connexion exigée', checkPartnerAccess(fakeReq(''), cfg).reason === 'login_required');
  check('avec la session → accès', checkPartnerAccess(fakeReq(cookie), cfg).ok === true);
  r = await fetch(`${B}/partner/${SLUG}-off/auth/login`);
  check('partenaire sans annuaire ni OpenID → 404', r.status === 404);
} catch (err) {
  failures++;
  console.error('\n\x1b[31mErreur du harnais :\x1b[0m', err);
} finally {
  const m = await PartnerMember.deleteMany({ partnerSlug: { $in: [SLUG, `${SLUG}-off`] } });
  const c = await PartnerLoginCode.deleteMany({ partnerSlug: { $in: [SLUG, `${SLUG}-off`] } });
  check('données de test effacées', (await PartnerMember.countDocuments({ partnerSlug: SLUG })) === 0, `${m.deletedCount} fiche(s), ${c.deletedCount} code(s)`);
  srv.close();
  await mongoose.disconnect();
  const after = fs.existsSync(REAL_CFG) ? fs.readFileSync(REAL_CFG, 'utf8') : null;
  check('configuration partenaire réelle intacte', after === REAL_BEFORE);
  process.chdir(ROOT);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log(failures === 0 ? '\n\x1b[32mTous les contrôles passent.\x1b[0m' : `\n\x1b[31m${failures} contrôle(s) en échec.\x1b[0m`);
  process.exit(failures ? 1 : 0);
}
