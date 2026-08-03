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

To check what a page will actually render without spinning up the server, load `src/services/customization.js` and call `loadCustomization({ seasonCode, eventSlug, partnerSlug, locale })` directly — it returns the fully merged, locale-resolved object.
