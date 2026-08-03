# i18n glossary — most frequent end-user terms

Companion to the i18n architecture discussion (locale-keyed values in the
existing `data/customization` merge chain, `t()` catalog for structural
chrome, `Order.locale` capture for async email/ticket rendering). This is a
frequency/spread analysis of the actual French vocabulary in end-user-facing
surfaces today, with proposed EN translations, meant to seed both the
structural `locales/en.json` catalog and the translation of `default.json`.

**Scope scanned**: `src/views/order/index.ejs`, `src/views/pay/start.ejs`,
`src/views/partner/{index,events}.ejs`, `public/static/js/{event,generic-view,
partner}.js`, `src/services/mailer.js`, `src/services/tickets-pdf.js`,
`data/templates/email/*.html`, `data/customization/**/*.json`.
`src/views/scan/index.ejs` and `public/static/js/scan.js` (staff gate tool)
were scanned but excluded from priority counts — same low-priority bucket as
the admin GUI, per your framing.

"Spread" = number of distinct files/subsystems using the term. High-spread
terms matter most for a shared glossary: a word only used once can be
translated freely in place, but a word used in 5 unrelated files needs one
agreed EN term applied consistently, or the translated app will read as
inconsistently as the French/English mix it's replacing.

## Franglais already in the codebase today (before any translation work)

Worth fixing regardless of the i18n project, since these are the exact
inconsistency the "franglais" complaint is about — same concept, different
language, in different files:

| Concept | French form | English form (already present!) | Where |
|---|---|---|---|
| Sale status badges | `Ventes fermées`, `Prévente partenaire` | `SALE OPENED`, `PRESALE OPENED`, `SALE CLOSED` | `generic-view.js`/`event.js` (FR) vs `partner/events.ejs` (EN, all-caps) — same status, opposite language depending which page renders it |
| Scan mode toggle | `Commande` | `Ticket` | `scan.js` — two options of the *same* toggle control, one French one English |
| Scan auth fields | `Mot de passe` | `Token`, `Login` | `scan/index.ejs` — same form, mixed |
| Header title | — | `ACESS CONTROL` | `scan/index.ejs` — also misspelled ("ACCESS") |

## Core domain nouns

| French | Proposed EN | Freq. (approx.) | Spread | Notes |
|---|---|---|---|---|
| Abonnement | Season pass *(or "Subscription")* | 15+ | customization (×6 files), emails (×3), tickets-pdf, order defaults | Pick **one** EN term and hold it everywhere — "Season pass" reads more natural for a sports/venue context than literal "Subscription"; your call |
| Billet(s) | Ticket(s) | 12+ | customization, mailer.js, scan.js, partner/events.ejs | `Billetterie` → "Box office" / "Ticketing" depending on context (see phrase section) |
| Commande | Order | 8 | mailer.js, email templates, scan.js, generic-view.js | Also used as a *mode* label in scan.js (see franglais table) |
| Place | Seat | 8 | order/index.ejs (default column), 3× email templates, mailer.js table header, scan.js | **Conflicts with `Siège`** below — same concept, two French words already in use inconsistently |
| Siège | Seat | 4 | generic-view.js only (`siège isolé`, `Siège indisponible`) | Should collapse to the *same* EN word as `Place` — good opportunity to fix the French inconsistency as part of translating |
| Tarif | Rate / Price tier | 7 | order default column, 3× email templates, tickets-pdf (`tariffTitle`) | "Tarif" as a table header often just becomes "Price" in EN; "Price tier" better where it names a *category* (NORMAL/REDUCED) |
| Total | Total | 5 | order/index.ejs, pay/start.ejs, 3× email templates | Same word in EN, no-op |
| Montant | Amount | 3 | email templates (table column) | |
| Bénéficiaire | Beneficiary / Ticket holder | 4 | email templates, scan.js (`Place — Bénéficiaire`) | "Ticket holder" reads more natural in EN UI copy than literal "Beneficiary" |
| Saison | Season | 10+ | customization keys (`seasonName`/`seasonCode` everywhere), mailer.js, email templates | |
| Événement / Match | Event / Match | 8 | customization, partner/events.ejs, scan.js, event.js | `Match` used as both a generic fallback name (`'Match'` in mailer.js/tickets-pdf.js) *and* a literal event-type word — check which meaning at each site |
| Zone | Zone | 5 | order/index.ejs, generic-view.js, event.js | Same word in EN, no-op |
| Prénom / Nom | First name / Last name | 6 | order/index.ejs defaults, generic-view.js | |
| Lieu | Venue | 3 | customization, email templates | "Location" also viable; "Venue" fits ticketing domain better |
| Code | Code | 2 | mailer.js (ticket code table header) | Likely fine as-is, or "Ref." |
| Statut | Status | 2 | order/index.ejs (`Statut de la réservation`) | |
| Réservation | Booking | 2 | order/index.ejs | "Reservation" also fine; "Booking" more common in EN ticketing UX |
| Paiement | Payment | 6+ | pay/start.ejs title, order/index.ejs default, email templates | |
| Échéance(s) / Échéancier | Installment(s) / Payment schedule | 6 | order/index.ejs (`scheduleLabel`, `optionLabels`), mailer.js (`humanInstallments`), email templates | Finance-specific — "En 2 fois" → "In 2 installments"; needs a small phrase family, see below |
| Ventes / Vente | Sales | 3 | generic-view.js, partner/events.ejs (as `SALE`) | |
| Prévente | Presale | 3 | generic-view.js, event.js, partner/events.ejs (as `PRESALE`) | |
| Quota | Quota | 3 | generic-view.js, event.js | Same word in EN, no-op |
| Plan | Floor plan / Seating plan | 2 | order/index.ejs (`planTitleText`, aria-label) | Literal "Plan" ambiguous in EN; qualify it |
| Partenaire | Partner | 5+ | customization, event.js, partner/*.ejs | Same word in EN, no-op |

## Recurring phrase patterns (not single words)

These matter more than individual nouns for consistency — they're templates
reused with small variations across `generic-view.js` and `partner.js`:

- **Inability/retry family**: `Impossible de {verb} votre {noun}. Réessayez.` — appears 4+ times with different verbs/nouns (`traiter votre demande`, `enregistrer votre demande`, `charger les données`, `démarrer le paiement`). Proposed: `Unable to {action}. Please try again.` — worth defining as a single parameterized catalog entry rather than 4 separate translated strings, so future new error messages reuse the same EN phrasing automatically.
- **Technical-problem fallback**: `Un problème technique est survenu. Réessayez dans quelques instants.` (appears twice verbatim) → `Something went wrong. Please try again in a moment.`
- **Sales-closed pair**: `Billetterie fermée` / `Les ventes sont closes pour cet événement.` (appears twice verbatim, title+body) → `Box office closed` / `Sales are closed for this event.`
- **Installment options**: `"1": "En 1 fois"`, `"2": "En 2 fois"`, `"3": "En 3 fois"` → `"Single payment"`, `"In 2 installments"`, `"In 3 installments"` (not a literal per-number template — English doesn't pluralize this the same way French's `En N fois` does).
- **Confirmation footer**: `{{clubName}} — Merci pour votre soutien.` (customization `event.confirmation.footer`, also emails as `Merci pour votre soutien ❤️🖤`) → `{{clubName}} — Thank you for your support.`
- **Email-sent notice**: `Un email de confirmation sera envoyé {après paiement | à l'adresse indiquée}.` (3 near-duplicate variants across `default.json` alone) → `A confirmation email will be sent {after payment | to the address provided}.`

## Proper nouns / do-not-translate

- **"Les Bélougas"** (`mailer.js` ×4, `tickets-pdf.js`) — club name, keep as-is in every locale.
- **"BTS"** — product/org short name, keep as-is.
- **Partner/venue slugs, event names** — already come through as data (`{{partnerName}}`, `{{eventName}}`), not literal strings to translate.

## Suggested next step

This is a large-enough vocabulary that I'd turn the "Core domain nouns" table
directly into the seed `t()` catalog keys (e.g. `common.seat`, `common.ticket`,
`common.total`) referenced from both structural chrome *and* as the
`{{var}}`-adjacent building blocks for `default.json`'s English translation —
rather than translating each of the ~25 `default.json`/email-template strings
independently, which risks exactly the inconsistency this glossary is trying
to avoid (e.g. "Seat" in one file, "Place" left untranslated in another).

Happy to turn this into the actual `locales/en.json` + `locales/fr.json`
skeleton next, once you've had a chance to sanity-check the term choices
above (particularly **Abonnement → "Season pass" vs "Subscription"**, since
that one ripples through the most files).
