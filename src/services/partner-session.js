// src/services/partner-session.js
//
// Session partenaire issue d'une authentification OIDC, portée par un cookie
// signé. Pas de stockage serveur : l'état tient dans un JWT court, ce qui
// évite d'ajouter une table et un nettoyage pour une session qui dure le temps
// d'un achat.
//
// Le cookie est nominatif du partenaire (`bts_partner_<slug>`) : un
// bénéficiaire authentifié chez un partenaire n'obtient rien chez un autre.
import jwt from 'jsonwebtoken';

const TTL_SECONDS = Number(process.env.PARTNER_SESSION_TTL_MIN || 120) * 60;

function secret() {
  // Même secret que les liens de renouvellement : une installation en a déjà
  // un, et en exiger un second ne rendrait pas la session plus sûre.
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET requis pour les sessions partenaire');
  return s;
}

export function cookieNameFor(slug) {
  return `bts_partner_${String(slug || '').trim().toLowerCase()}`;
}

export function issueSession(res, { slug, identity, via = 'oidc' }) {
  const token = jwt.sign(
    { slug, sub: identity.subject, email: identity.email || '', name: identity.name || '', via },
    secret(),
    { expiresIn: TTL_SECONDS }
  );
  res.cookie(cookieNameFor(slug), token, {
    httpOnly: true,                 // inaccessible au JavaScript de la page
    sameSite: 'lax',                // survit au retour de redirection de l'IdP
    secure: String(process.env.APP_URL || '').startsWith('https://'),
    maxAge: TTL_SECONDS * 1000,
    path: '/'
  });
  return token;
}

export function clearSession(res, slug) {
  res.clearCookie(cookieNameFor(slug), { path: '/' });
}

// cookie-parser n'est pas installé : on lit l'en-tête comme le fait
// middlewares/locale.js, plutôt que d'ajouter une dépendance pour un cookie.
function cookieFromHeader(header, name) {
  const raw = String(header || '');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(idx + 1).trim()); }
    catch { return part.slice(idx + 1).trim(); }
  }
  return '';
}

/** Session valide pour CE partenaire, ou null. */
export function readSession(req, slug) {
  const raw = req.cookies?.[cookieNameFor(slug)]
    || cookieFromHeader(req.headers?.cookie, cookieNameFor(slug));
  if (!raw) return null;
  try {
    const claims = jwt.verify(raw, secret());
    // Le slug est revérifié : un cookie recopié d'un partenaire à l'autre ne
    // doit pas être accepté au seul motif qu'il est bien signé.
    if (String(claims.slug || '') !== String(slug || '').trim().toLowerCase()) return null;
    return claims;
  } catch {
    return null;
  }
}
