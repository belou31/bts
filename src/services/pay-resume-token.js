// src/services/pay-resume-token.js
//
// Signs/verifies the token behind the /pay/resume link (src/routes/pay.js).
// Deliberately its own tiny module, not colocated inside pay.js: that file
// reads several env vars as frozen top-level consts (PAYMENT_PROVIDER_ID,
// BASE_PATH, …), evaluated at import time — fine for the live server, where
// dotenv has already run by the time anything imports it, but scripts/*.js
// CLI entry points call dotenv.config() in their own body, AFTER their
// static imports have already been evaluated (an ES module hoisting
// gotcha — see the same note in src/routes/seat-change.js). Importing the
// whole pay.js from scripts/04-event-management/send-payment-links.js or
// src/services/importers/eventOrdersImporter.js would risk those constants
// freezing on empty/default values. This module only ever reads
// JWT_SECRET, and only lazily, inside the functions below — so it's safe to
// import from either context.

import jwt from 'jsonwebtoken';

const TOKEN_KIND = 'pay-resume';
const jwtSecret = () => process.env.JWT_SECRET;

export function decodePayResumeToken(id) {
  const secret = jwtSecret();
  if (!id || !secret) return null;
  try {
    const tok = jwt.verify(id, secret);
    return tok?.kind === TOKEN_KIND ? tok : null;
  } catch {
    return null;
  }
}

/**
 * Signs the link emailed instead of a direct PSP URL. When `startsAt` (an
 * event's kickoff) is given, the link expires then — same reasoning as
 * seat-change.js's signSeatChangeToken: paying for a ticket to a match that
 * already happened makes no sense. Otherwise falls back to a flat `ttlDays`
 * window, so this stays usable for a non-event order too.
 */
export function signPayResumeToken({ orderId, startsAt = null, ttlDays = 30 }) {
  const secret = jwtSecret();
  if (!secret) throw new Error('JWT_SECRET manquant');
  const exp = startsAt
    ? Math.floor(new Date(startsAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
  return jwt.sign({ kind: TOKEN_KIND, orderId: String(orderId), exp }, secret);
}
