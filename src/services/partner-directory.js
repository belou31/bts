// src/services/partner-directory.js
//
// Annuaire local d'un partenaire qui n'a pas de fournisseur d'identité.
//
// Activation : `"connection": "directory"` dans partners.json (script
// set-partner-connection.js, cf. services/partner-connection.js).
// L'administrateur du partenaire importe la liste
// de ses ayants droit en CSV sur /partner/<slug>/admin/directory ; l'ayant
// droit se connecte en saisissant son identifiant ET l'une des adresses
// e-mail de la liste, puis le code reçu par e-mail. La session ouverte est la
// même qu'avec OpenID (identifiant, nom, e-mail, attributs) : droits et
// panneau Contact fonctionnent à l'identique.
//
// CSV : une ligne par adresse e-mail ; un identifiant répété sur plusieurs
// lignes reçoit plusieurs adresses.
//
//   identifier,redirect,lastName,firstName,email,beneficiaries,extraPublic
//   A123456,,DUPONT,Camille,camille.dupont@example.com,4,2
//   A123456,,DUPONT,Camille,c.dupont@perso.example,4,2
//   A123457,A123456,DUPONT,Léo,leo.dupont@example.com,1,
//
// `extraPublic` (facultative) : places en plus au tarif public propres à cet
// ayant droit, attribut de session du même nom (cf. entitlements, max
// { attribute: "extraPublic", default: … }). Vide : la valeur par défaut.
//
// `redirect` (facultative) : identifiant d'une autre fiche, celle de la
// famille. On se connecte avec sa propre ligne (identifiant + e-mail), mais la
// session porte l'identifiant et le nom de la fiche visée — commandes et
// compteur de droits communs, les places se réservent ensemble — et garde
// l'e-mail de connexion. Le quota de la famille additionne `beneficiaries`
// (et `extraPublic`) de la fiche visée et de celles qui la désignent. Pas de
// chaîne : la fiche visée ne redirige pas elle-même.
import crypto from 'crypto';
import { PartnerMember } from '../models/PartnerMember.js';
import { PartnerLoginCode } from '../models/PartnerLoginCode.js';
import { sendMail } from '../loaders/mailer.js';
import { partnerConnection } from './partner-connection.js';
import { splitCsvLine, detectCsvDelimiter } from '../utils/csv-line.js';

export const CODE_TTL_MIN = 10;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_CODES_PER_WINDOW = 3;
export const CODE_WINDOW_MIN = 15;
const COLUMNS = ['identifier', 'lastname', 'firstname', 'email', 'beneficiaries'];
// Colonnes facultatives : absentes de l'en-tête, la valeur vaut null.
const OPTIONAL_COLUMNS = ['extrapublic', 'redirect'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function directoryEnabled(cfg) {
  return partnerConnection(cfg) === 'directory';
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/**
 * { members, errors } — `errors` liste les lignes ou identifiants écartés,
 * avec le motif. Un identifiant dont les lignes se contredisent (nom, nombre
 * de places) est écarté en entier : mieux vaut l'absent que l'un des deux
 * choisi au hasard.
 */
export function parseDirectoryCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const errors = [];
  const headerIdx = lines.findIndex(l => l.trim() && !l.trim().startsWith('#'));
  if (headerIdx < 0) return { members: [], errors: [{ line: 0, reason: 'fichier vide' }] };

  const headerLine = lines[headerIdx];
  const delimiter = detectCsvDelimiter(headerLine);
  const header = splitCsvLine(headerLine, delimiter).map(h => h.toLowerCase());
  const missing = COLUMNS.filter(c => !header.includes(c));
  if (missing.length) {
    return { members: [], errors: [{ line: headerIdx + 1, reason: `colonnes manquantes : ${missing.join(', ')} (attendu : identifier,lastName,firstName,email,beneficiaries)` }] };
  }
  const col = Object.fromEntries([...COLUMNS, ...OPTIONAL_COLUMNS].map(c => [c, header.indexOf(c)]));

  const byId = new Map();
  const rejected = new Set();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const cells = splitCsvLine(raw, delimiter);
    const get = (c) => (col[c] >= 0 ? cells[col[c]] ?? '' : '');
    const lineNo = i + 1;
    const identifier = get('identifier');
    const email = get('email').toLowerCase();
    const benefRaw = get('beneficiaries');
    if (!identifier) { errors.push({ line: lineNo, reason: 'identifiant vide' }); continue; }
    if (!EMAIL_RE.test(email)) { errors.push({ line: lineNo, identifier, reason: `e-mail invalide : « ${get('email')} »` }); continue; }
    let beneficiaries = null;
    if (benefRaw !== '') {
      const n = Number(benefRaw);
      // 0 admis : l'ayant droit reste connectable, sans place au titre des droits.
      if (!Number.isInteger(n) || n < 0) { errors.push({ line: lineNo, identifier, reason: `beneficiaries doit être un entier ≥ 0 : « ${benefRaw} »` }); continue; }
      beneficiaries = n;
    }
    const extraRaw = get('extrapublic');
    let extraPublic = null;
    if (extraRaw !== '') {
      const n = Number(extraRaw);
      if (!Number.isInteger(n) || n < 0) { errors.push({ line: lineNo, identifier, reason: `extraPublic doit être un entier ≥ 0 : « ${extraRaw} »` }); continue; }
      extraPublic = n;
    }
    const redirectRaw = get('redirect');
    const redirect = redirectRaw && redirectRaw.toUpperCase() !== identifier.toUpperCase() ? redirectRaw : null;
    const row = { identifier, redirect, lastName: get('lastname'), firstName: get('firstname'), beneficiaries, extraPublic };
    const key = identifier.toUpperCase();
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, { ...row, emails: [email], lines: [lineNo] });
      continue;
    }
    const conflict = ['redirect', 'lastName', 'firstName', 'beneficiaries', 'extraPublic'].find(f => String(prev[f] ?? '').toUpperCase() !== String(row[f] ?? '').toUpperCase());
    if (conflict) {
      rejected.add(key);
      errors.push({ line: lineNo, identifier, reason: `« ${conflict} » diffère de la ligne ${prev.lines[0]} pour le même identifiant` });
      continue;
    }
    if (!prev.emails.includes(email)) prev.emails.push(email);
    prev.lines.push(lineNo);
  }

  for (const key of rejected) {
    errors.push({ line: byId.get(key).lines[0], identifier: byId.get(key).identifier, reason: 'identifiant écarté (lignes contradictoires)' });
  }
  // Redirections : la fiche visée doit être retenue et ne pas rediriger
  // elle-même. Sinon la fiche qui redirige est écartée — connectée seule, elle
  // réserverait hors de sa famille.
  for (const [key, m] of byId) {
    if (rejected.has(key) || !m.redirect) continue;
    const target = byId.get(m.redirect.toUpperCase());
    let reason = null;
    if (!target) reason = `redirect « ${m.redirect} » : identifiant absent du fichier`;
    else if (rejected.has(m.redirect.toUpperCase())) reason = `redirect « ${m.redirect} » : identifiant visé écarté`;
    else if (target.redirect) reason = `redirect « ${m.redirect} » : l'identifiant visé redirige lui-même vers « ${target.redirect} »`;
    if (reason) {
      rejected.add(key);
      errors.push({ line: m.lines[0], identifier: m.identifier, reason });
    } else {
      m.redirect = target.identifier;
    }
  }

  const members = [...byId.entries()]
    .filter(([key]) => !rejected.has(key))
    .map(([, m]) => ({
      identifier: m.identifier, redirect: m.redirect, lastName: m.lastName, firstName: m.firstName,
      emails: m.emails, beneficiaries: m.beneficiaries, extraPublic: m.extraPublic
    }));
  return { members, errors };
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ── Annuaire ────────────────────────────────────────────────────────────────

/**
 * Remplace l'annuaire du partenaire. Les nouvelles fiches sont écrites
 * d'abord, les anciennes retirées ensuite : à aucun moment l'annuaire n'est
 * vide pour qui se connecte pendant l'import.
 */
export async function replaceDirectory(partnerSlug, members) {
  const slug = String(partnerSlug).toLowerCase();
  const importedAt = new Date();
  if (members.length) {
    await PartnerMember.bulkWrite(members.map(m => ({
      updateOne: {
        filter: { partnerSlug: slug, identifier: m.identifier },
        update: { $set: { ...m, partnerSlug: slug, importedAt } },
        upsert: true
      }
    })), { ordered: false });
  }
  const removed = await PartnerMember.deleteMany({ partnerSlug: slug, importedAt: { $ne: importedAt } });
  return { imported: members.length, removed: removed.deletedCount || 0, importedAt };
}

export async function directoryStats(partnerSlug) {
  const slug = String(partnerSlug).toLowerCase();
  const [count, redirected, last, emails] = await Promise.all([
    PartnerMember.countDocuments({ partnerSlug: slug }),
    PartnerMember.countDocuments({ partnerSlug: slug, redirect: { $type: 'string' } }),
    PartnerMember.findOne({ partnerSlug: slug }, { importedAt: 1 }).sort({ importedAt: -1 }).lean(),
    PartnerMember.aggregate([{ $match: { partnerSlug: slug } }, { $project: { n: { $size: '$emails' } } }, { $group: { _id: null, n: { $sum: '$n' } } }])
  ]);
  return { members: count, redirected, emails: emails?.[0]?.n || 0, lastImport: last?.importedAt || null };
}

/** Annuaire courant au format d'import (une ligne par adresse). */
export async function exportDirectoryCsv(partnerSlug) {
  const rows = await PartnerMember.find({ partnerSlug: String(partnerSlug).toLowerCase() }).sort({ identifier: 1 }).lean();
  const out = ['identifier,redirect,lastName,firstName,email,beneficiaries,extraPublic'];
  for (const m of rows) {
    for (const email of m.emails || []) {
      out.push([m.identifier, m.redirect ?? '', m.lastName, m.firstName, email, m.beneficiaries ?? '', m.extraPublic ?? ''].map(csvCell).join(','));
    }
  }
  return out.join('\n') + '\n';
}

// L'identifiant se compare sans tenir compte de la casse (A123456 = a123456).
function findMember(partnerSlug, identifier) {
  return PartnerMember.findOne({ partnerSlug: String(partnerSlug).toLowerCase(), identifier: String(identifier || '').trim() })
    .collation({ locale: 'fr', strength: 2 }).lean();
}

// ── Codes de connexion ──────────────────────────────────────────────────────

// HMAC plutôt qu'un simple haché : six chiffres se retrouvent en un instant à
// partir d'un haché nu si la base fuit ; sans le secret, non.
function codeHash(partnerSlug, identifier, code) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET requis pour les codes de connexion');
  return crypto.createHmac('sha256', secret).update(`${partnerSlug}|${identifier}|${code}`).digest('hex');
}

function codeEmailHtml({ partnerName, code }) {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<p>Bonjour,</p>
<p>Votre code de connexion à la billetterie ${esc(partnerName)} :</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px">${esc(code)}</p>
<p>Il est valable ${CODE_TTL_MIN} minutes et ne sert qu'une fois. Si vous n'avez pas demandé ce code, ignorez ce message.</p>`;
}

/**
 * Envoie un code si l'identifiant existe ET que l'adresse lui appartient.
 * La réponse à l'utilisateur ne dit jamais lequel des deux a échoué (pas
 * d'énumération de l'annuaire) ; `reason` ne sert qu'au journal.
 */
export async function requestLoginCode({ partnerSlug, partnerName, identifier, email }) {
  const slug = String(partnerSlug).toLowerCase();
  const mail = String(email || '').trim().toLowerCase();
  const member = await findMember(slug, identifier);
  if (!member || !member.emails.includes(mail)) return { sent: false, reason: 'no_match' };

  const since = new Date(Date.now() - CODE_WINDOW_MIN * 60 * 1000);
  const recent = await PartnerLoginCode.countDocuments({ partnerSlug: slug, identifier: member.identifier, createdAt: { $gte: since } });
  if (recent >= MAX_CODES_PER_WINDOW) return { sent: false, reason: 'rate_limited' };

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await PartnerLoginCode.create({
    partnerSlug: slug,
    identifier: member.identifier,
    email: mail,
    codeHash: codeHash(slug, member.identifier, code),
    expiresAt: new Date(Date.now() + CODE_TTL_MIN * 60 * 1000)
  });
  await sendMail({
    to: mail,
    subject: `Votre code de connexion — ${partnerName || slug}`,
    html: codeEmailHtml({ partnerName: partnerName || slug, code })
  });
  return { sent: true };
}

/**
 * Fiche de l'ayant droit si le code est bon, sinon null. Seul le dernier code
 * émis pour cet identifiant et cette adresse est valable ; chaque essai le
 * consomme d'une tentative, la bonne réponse le consomme entièrement.
 */
export async function verifyLoginCode({ partnerSlug, identifier, email, code }) {
  const slug = String(partnerSlug).toLowerCase();
  const mail = String(email || '').trim().toLowerCase();
  const member = await findMember(slug, identifier);
  if (!member || !member.emails.includes(mail)) return null;

  const entry = await PartnerLoginCode.findOne({
    partnerSlug: slug, identifier: member.identifier, email: mail,
    usedAt: null, expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 });
  if (!entry || entry.attempts >= MAX_CODE_ATTEMPTS) return null;

  entry.attempts += 1;
  const expected = Buffer.from(entry.codeHash, 'hex');
  const given = Buffer.from(codeHash(slug, member.identifier, String(code || '').trim()), 'hex');
  const ok = expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (ok) entry.usedAt = new Date();
  await entry.save();
  return ok ? member : null;
}

// Somme des valeurs renseignées ; null si aucune (la valeur par défaut du
// panier de droits s'applique alors).
function sumOrNull(values) {
  const set = values.filter(v => v !== null && v !== undefined);
  return set.length ? set.reduce((a, b) => a + Number(b), 0) : null;
}

/**
 * Identité de session, de même forme que celle issue d'OpenID. `group` : les
 * fiches de la famille (la fiche elle-même comprise), dont les nombres de
 * places s'additionnent ; `loginIdentifier` : la fiche qui s'est connectée,
 * si elle diffère.
 */
export function identityFromMember(member, email, { group = [member], loginIdentifier = null } = {}) {
  const attributes = {
    beneficiaries: sumOrNull(group.map(m => m.beneficiaries)),
    extraPublic: sumOrNull(group.map(m => m.extraPublic))
  };
  if (loginIdentifier && loginIdentifier !== member.identifier) attributes.loginIdentifier = loginIdentifier;
  return {
    identifier: member.identifier,
    firstName: member.firstName || '',
    lastName: member.lastName || '',
    email: String(email || member.emails?.[0] || '').toLowerCase(),
    name: [member.firstName, member.lastName].filter(Boolean).join(' '),
    attributes
  };
}

/**
 * Identité de session pour la fiche qui vient de se connecter : celle de la
 * fiche visée par `redirect` s'il y en a une, avec le quota de toute la
 * famille, et l'e-mail de connexion.
 */
export async function directoryIdentity(partnerSlug, member, email) {
  const slug = String(partnerSlug).toLowerCase();
  const head = (member.redirect && await findMember(slug, member.redirect)) || member;
  const others = await PartnerMember.find({ partnerSlug: slug, redirect: head.identifier })
    .collation({ locale: 'fr', strength: 2 }).lean();
  const group = [head, ...others.filter(m => m.identifier !== head.identifier)];
  return identityFromMember(head, email, { group, loginIdentifier: member.identifier });
}
