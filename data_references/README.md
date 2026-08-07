# Script Templates

This directory gathers ready-to-copy templates for CSV, ENV, and asset files used by the operational scripts.

- `env/.env.template` — baseline environment variables required by CLI scripts.
- `csv/…` — sample structures for CSV imports/exports. Update headers if your business rules change.
- `files/plan.svg` — minimalist seating plan to help start a new venue mapping.
- `csv/seats-hold-release.template.csv` — shared template for `block-free-seats-for-event` and `block-free-seats-for-season` (supports `seatPattern` regexes and zero-padded seatIds).

Copy the relevant template next to your data, rename it, then fill it with real values before running the script.

When using the admin interface, upload the prepared files via the “Upload” buttons—files are deposited in `data/inputs`, while generated exports are published under `data/outputs`.

## Channel-aware tariffs

Tariff- and price-related CSV templates now expose a `channels` column. Populate it with space/comma-separated scopes such as `public`, `partner` or `partner:csebla`. Leave the cell empty (or omit the column) to keep the tariff public. Values are case-insensitive, and you can combine several scopes (e.g. `partner partner:csebla`). These scopes are used server-side to decide which routes (public event vs. partner) may display a tariff or price row.

## Renewers registry

Use `csv/subscribers-export.template.csv` as the target schema for the **Export Renewers** script (`scripts/03-season-management/export-subscribers.js`). This file now represents the next-season renewer list exclusively; subscription order imports no longer mutate that collection automatically, so remember to run the export at season closure and keep it as the seed for the following campaign.

## Customization files

Page/email text (titles, lead paragraphs, help text, button labels — see `customization/default.json`, `event.json`, `partner.json`, `season.json` in this directory) is resolved by `src/services/customization.js` at request time by layering up to six JSON files, **narrowest wins**:

```
data/customization/default.json
  → seasons/<seasonCode>.json
    → events/<eventSlug>.json
      → partners/<partnerSlug>.json
        → partners/<partnerSlug>/seasons/<seasonCode>.json
          → partners/<partnerSlug>/events/<eventSlug>.json
```

**Only `default.json` should contain every key.** Every other layer should contain *only the keys that actually differ* for that season/event/partner — not a full copy of `default.json`. If you paste the whole baseline into e.g. `events/Match.json`, a later wording fix in `default.json` will silently stop reaching that event, because the event file already forked its own copy of every key. The `event.json` / `partner.json` / `season.json` files here list the *menu* of keys available at that level — copy the one or two you need, not the whole file.

**Value shape**: each key's value can be a plain string (used for every locale) or `{ "fr": "...", "en": "..." }` (recommended — keeps the page bilingual). Don't mix shapes for the same key across layers.

**Two unrelated "partners" files — don't confuse them:**
- `data/customization/partners.json` (singular, one file) — partner *business config*: `paymentMode`, `accessToken`, `presale` quotas, `venueViews`. Managed by the `scripts/05-partner-management/*.js` scripts other than `set-partner-custo.js`.
- `data/customization/partners/<slug>.json` (plural dir, one file per partner) — partner *text overrides*, written by `set-partner-custo.js`.

To check what a page will actually render without spinning up the server, load `src/services/customization.js` and call `loadCustomization({ seasonCode, eventSlug, partnerSlug, locale })` directly — it returns the fully merged, locale-resolved object. Or run `node scripts/00-system-management/resolve-custo.js [--season=...] [--event=...] [--partner=...]` for the same thing with provenance (which file won each key) and typo detection.

## Email & ticket templates

`data/templates/email/*.html` and `data/templates/tickets/*.svg` are the actual documents sent to customers — different data from `data/customization` (page copy) and resolved differently: by **kind**, not by season/event/partner.

**Kind resolution** — two separate functions, can disagree for the same order:
- Email: `resolveOrderKind()` in `src/services/mailer.js` → `renew` / `subscription` / `event` / `public`.
- Ticket PDF: the kind switch in `buildTicketsPdfBuffer()` in `src/services/tickets-pdf.js` → `event` / `subscription` / `public` (no `renew` — a renewal's ticket is just a `subscription` ticket).

**`data/templates/templates.json`** (one shared file, `email.templates.*` and `tickets.templates.*` sections) maps `kind → file` — this is file-system routing, not content, so it's kept separate from customization JSON. Editing it directly works, but prefer `set-email-template.js` / `set-ticket-template.js` (below) — they validate, diff, and warn about known kinds.

**Subject text is NOT in `templates.json`** — it's a customization key (`<kind>.emailSubject`, e.g. `event.emailSubject`), resolved through the same season/event/partner layering as everything else in `data/customization`. Precedence: `EMAIL_SUBJECT_*_CONFIRM` env var (ops override) → the customization key (narrowest layer wins, per the usual rules above) → i18n code default. Set it with the normal `set-*-custo.js` scripts, not the template scripts.

**Theme variants** — an *optional* third dimension, orthogonal to kind: a `theme` customization key (plain string, e.g. `"halloween"` or a partner's own slug) makes `mailer.js`/`tickets-pdf.js` try `<kind>-confirmation.<theme>.html` / `ticket.<theme>.svg` before the base file, falling back cleanly if that variant doesn't exist. Since `theme` is resolved through the same customization layering, an event-scoped theme (in `events/<slug>.json`) only affects that event, and a partner-scoped theme (in `partners/<slug>.json`) applies to that partner everywhere, no matter the event. Set the theme value with `set-*-custo.js`, then install the actual variant file with `set-email-template.js --theme=<name>` / `set-ticket-template.js --theme=<name>` — those flags derive the right filename automatically and skip `templates.json` entirely (theme variants are pure file-existence, not declared anywhere).

**`data/assets/`** (favicon, logo, icons) is a sibling of `data/templates/`, not nested inside it — these are static files embedded into templates and served to browsers, not templates themselves.

**Ticket logo overrides** — same mechanism as theme: a `logo` customization key (plain string, e.g. `"assets/partner01-badge.svg"`) makes `tickets-pdf.js` embed that file in the ticket's logo slot instead of the per-kind default in `templates.json`. Precedence: `CLUB_LOGO_SVG_PATH` env var → the `logo` customization key (narrowest layer wins) → `templates.json`'s per-kind `logo` → `public/dynamic/assets/logo.png` as the last resort. Stage the file with `node scripts/00-system-management/import-templates.js --resource=logo --file=<path>` (copies into `data/assets/`, no `templates.json` write), then set the `logo` key with the usual `set-*-custo.js` scripts — staging the file alone changes nothing until a customization layer actually points at it. A ticket that needs a one-off logo with no reuse elsewhere can just have it baked directly into that ticket's own SVG instead (see `set-ticket-template.js --theme=`) — the customization key is for a logo that should apply broadly (a partner's badge on every one of their events, for instance) without duplicating it into every ticket variant.

Both template config caches (`EMAIL_CONFIG_PROMISE`, `TICKET_CONFIG_CACHE`) are loaded once and kept for the life of the process — unlike customization JSON, which is read fresh on every request. After changing `templates.json` or adding/removing a template file, restart the server: `node scripts/00-system-management/pm2-control.js --name=bts --action=restart`.
