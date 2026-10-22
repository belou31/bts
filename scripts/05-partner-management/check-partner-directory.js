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
  p = D.parseDirectoryCsv('identifier,nom,email\nA,B,c@d.fr\n');
  check('colonnes manquantes → refus', p.errors.length === 1 && /colonnes manquantes/.test(p.errors[0].reason));
  p = D.parseDirectoryCsv('identifier,lastName,firstName,email,beneficiaries\nA1,X,Y,pas-un-email,1\nA2,X,Y,a@b.fr,0\n');
  check('e-mail et nombre de places invalides signalés', p.errors.length === 2, p.errors.map(e => e.reason).join(' | '));

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
  check('page : statut et compteurs', /activée/.test(html) && /2 ayant\(s\) droit · 3 adresse\(s\)/.test(html));
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
