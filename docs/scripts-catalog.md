# Script Catalog & Admin Console

The repository consolidates all operational scripts under a shared catalog (`src/config/adminScripts.js`) and exposes them through the `/admin` console. Scripts are grouped by lifecycle stage so you can trigger them from the UI or from the CLI.

Each entry below references the canonical command, required environment variables, and optional template files you can copy before running the script. Unless noted otherwise, scripts look for input assets in `data/inputs` (where the admin upload stores files) and write their CSV exports to `data/outputs`.

## 00 — Initialization

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/00-system-management/reset-db.js` | Drop the MongoDB database defined in `.env`. Requires `--force`. | `node scripts/00-system-management/reset-db.js --force` | `data/templates/env/.env.template` |
| `scripts/00-system-management/check-env.js` | Validate the core `.env` configuration (APP_URL, HelloAsso, etc.). | `node scripts/00-system-management/check-env.js` | — |
| `scripts/00-system-management/customize-app.js` | Copy organization assets into `data/customization/assets` (mirrored to `public/static/img`) and persist names under `data/customization`. | `node scripts/00-system-management/customize-app.js --name="Club" [--logo-svg=logo.svg] [--logo-png=logo.png] [--favicon=favicon.ico] [--icon-192=icon-192.png] [--icon-512=icon-512.png]` | `data/templates/customization/app.json` |

## 01 — Venue Management

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/01-venue-management/register-venue.js` | Register or update a venue record (slug, display name, optional plan copy). | `node scripts/01-venue-management/register-venue.js <slug> "<Venue>" [plan.svg] [--overwrite]` | `data/templates/files/plan.svg` |
| `scripts/01-venue-management/import-seats.js` | Parse the persisted SVG plan for a venue and import seats, with optional CSV overrides. Can also enrich a specific view with seat attributes. | `node scripts/01-venue-management/import-seats.js --venue=<slug> [--csv=seats.csv] [--view=<viewSlug>]` | `data/templates/csv/seats.template.csv` |
| `scripts/01-venue-management/import-zones.js` | Maintain the venue zone catalog from CSV and/or SVG (`data-zone-id`). Can also enrich a specific view with zone attributes. | `node scripts/01-venue-management/import-zones.js --venue=<slug> [--csv=zones.csv] [--view=<viewSlug>]` | `data/templates/csv/zones.template.csv` |
| `scripts/01-venue-management/import-venue-view.js` | Copy a custom view for a venue to `src/public/static/venues/<slug>/views/<view>.svg` (no enrichment). | `node scripts/01-venue-management/import-venue-view.js <venueSlug> <viewSlug> <view.svg> [--overwrite]` | `data/templates/files/plan.svg` |

## 02 — Tariff Management

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/02-tariff-management/import-tariffs.js` | Import the global tariff catalog (code, label, justification). | `node scripts/02-tariff-management/import-tariffs.js tariff_catalog.csv` | `data/templates/csv/tariff-catalog.template.csv` |
| `scripts/02-tariff-management/export-tariffs.js` | Export the current tariff catalog to CSV. | `node scripts/02-tariff-management/export-tariffs.js [--out=tariff_catalog.csv]` | — |
| `scripts/02-tariff-management/import-tariff-prices.js` | Import reusable tariff prices (list or matrix) into a named catalog. | `node scripts/02-tariff-management/import-tariff-prices.js <catalogSlug> prices.csv [--venue=<slug>]` | `data/templates/csv/tariff-prices.template.csv` |
| `scripts/02-tariff-management/export-zone-tariffs.js` | Export the per-zone price matrix for review/sharing. | `node scripts/02-tariff-management/export-zone-tariffs.js <season> <slug> --out=prices.csv` | — |
| `scripts/02-tariff-management/export-zone-tariffs-matrix.js` | Produce a tariffCode × zone matrix (in euros). | `node scripts/02-tariff-management/export-zone-tariffs-matrix.js <season> <slug> [out.csv]` | — |
| `scripts/02-tariff-management/clone-zone-tariffs.mjs` | Clone tariffs from one zone to others (with optional discount). | `node scripts/02-tariff-management/clone-zone-tariffs.mjs --season=<code> --venue=<slug> --from-zone=<A1> --to-zones=<B1,B2>` | — |

## 03 — Season Management

### Core setup

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/03-season-management/create-season.js` | Create or update a season (code/name/active). | `node scripts/03-season-management/create-season.js <season> --name="..." [--active=true]` | — |
| `scripts/03-season-management/instantiate-venue-for-season.js` | Clone seat and zone catalogs into season-specific collections. | `node scripts/03-season-management/instantiate-venue-for-season.js <season> <slug> [--skip-seats] [--skip-zones]` | — |
| `scripts/03-season-management/instantiate-tariffs.js` | Apply one or more tariff matrix catalogs to a season/venue. | `node scripts/03-season-management/instantiate-tariffs.js <season> <slug> --catalog=<slug[,slug2]> [--clear]` | — |
| `scripts/03-season-management/import-subscription-orders.js` | Import subscription orders, book seats, and upsert subscribers. | `node scripts/03-season-management/import-subscription-orders.js orders.csv [--season=...] [--venue=...] [--status=paid] [--commit] [--sendEmails]` | `data/templates/csv/subscribers-import.template.csv` |
| `scripts/03-season-management/export-subscribers.js` | Export subscribers for a season/venue. | `node scripts/03-season-management/export-subscribers.js [--season=...] [--venue=...] [--activeOnly]` | `data/templates/csv/subscribers-export.template.csv` |
| `scripts/03-season-management/export-subscription-orders.js` | Export orders with phase `subscription` for audit. | `node scripts/03-season-management/export-subscription-orders.js [--season=...] [--venue=...] [--status=paid]` | `data/templates/csv/orders-export.template.csv` |
| `scripts/03-season-management/block-free-seats-for-season.js` | Block or free season seats from a CSV (seatId/regex/zone). | `node scripts/03-season-management/block-free-seats-for-season.js --file=<holds.csv> [--season=...] [--venue=...] [--commit] [--force]` | `data/templates/csv/seats-hold-release.template.csv` |

### Renewal workflow

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/03-season-management/import-renewers-flat.js` | Import renewal subscribers (flat CSV) and link seats. | `node scripts/03-season-management/import-renewers-flat.js subscribers.csv <season> --venue=<slug>` | `data/templates/csv/renew-subscribers.template.csv` |
| `scripts/03-season-management/renewal-provision-seats.js` | Provision previous-season seats for renewal (dry-run by default). | `node scripts/03-season-management/renewal-provision-seats.js <season> --venue=<slug> [--apply]` | — |
| `scripts/03-season-management/export-renew-groups.js` | Generate renewal tokens grouped per subscriber. | `node scripts/03-season-management/export-renew-groups.js <season> --venue=<slug> --base=<https://host/bts>` | `data/templates/csv/renew-groups.template.csv` |
| `scripts/03-season-management/export-renew-seats.js` | List seats involved in renewal (with signed URLs). | `node scripts/03-season-management/export-renew-seats.js <season> --venue=<slug>` | `data/templates/csv/renew-seats.template.csv` |
| `scripts/03-season-management/renewal-close-phase.js` | Disable renewal and release non-renewed seats. | `node scripts/03-season-management/renewal-close-phase.js <season> [--venue=<slug>]` | — |

## 04 — Event Management

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/04-event-management/create.js` | Create an event bound to a season (attach venue later). | `node scripts/04-event-management/create.js --slug=... --name="..." --date=ISO --season=<code> [--price-table=<key>]` | — |
| `scripts/04-event-management/instantiate-tariffs.js` | Instantiate event tariffs from catalog(s). | `node scripts/04-event-management/instantiate-tariffs.js --event=<slug> --catalog=<slug[,slug2]> [--clear] [--dry-run]` | — |
| `scripts/04-event-management/build-allowed-from-prices.js` | Recompute "allowed from" pricing based on zone tariffs. | `node scripts/04-event-management/build-allowed-from-prices.js --event=<slug>` | — |
| `scripts/04-event-management/set-onsale.js` | Toggle ticket sales for an event. | `node scripts/04-event-management/set-onsale.js --event=<slug|ObjectId> --open` | — |
| `scripts/04-event-management/import-qr-bank.js` | Import QR codes into a shared pool for the event. | `node scripts/04-event-management/import-qr-bank.js --event=<slug> --csv=<codes.csv>` | — |
| `scripts/04-event-management/block-free-seats-for-event.js` | Block or free seat holds for an event from a CSV (seatId/regex/zone). | `node scripts/04-event-management/block-free-seats-for-event.js --event=<slug> --file=holds.csv [--commit] [--force]` | `data/templates/csv/seats-hold-release.template.csv` |
| `scripts/04-event-management/send-all-season-tickets-for-event.js` | Generate/send season tickets (PDF) for an event based on the season subscriber base. | `node scripts/04-event-management/send-all-season-tickets-for-event.js --event=<slug> [--limit=200] [--dry-run]` | — |
| `scripts/04-event-management/import-orders.js` | Import or replay event orders from a CSV export. | `node scripts/04-event-management/import-orders.js <orders.csv> [--status=paid] [--commit] [--force] [--sendEmail]` | `data/templates/csv/event-orders.template.csv` |
| `scripts/04-event-management/export-orders.js` | Export event orders (one row per ticket) using the import-compatible layout. | `node scripts/04-event-management/export-orders.js --event=<slug> [--status=paid] [--out=orders.csv]` | `data/templates/csv/event-orders.template.csv` |
| `scripts/04-event-management/resend-event-tickets.js` | Resend event tickets for specific order IDs. | `node scripts/04-event-management/resend-event-tickets.js --event=<slug> --order=<orderId[,orderId2]> [--status=paid] [--dry-run]` | — |
| `scripts/04-event-management/tickets-pdf.js` | Produce a tickets PDF for a given order. | `node scripts/04-event-management/tickets-pdf.js <orderId>` | — |

## 05 — Partner Management

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/05-partner-management/init-partners.js` | Create `data/customization/partners.json` with starter entries (cseairbus, aisc). | `node scripts/05-partner-management/init-partners.js [--force]` | — |
| `scripts/05-partner-management/upsert-partner.js` | Add or update a partner entry (iframe allowlist, payment mode, UI copy). | `node scripts/05-partner-management/upsert-partner.js --slug=<slug> --name="<Name>" [--payment-mode=psp|invoice_auto] [--allowed-origins=...] [--frame-ancestors=...] [--payment-provider=...]` | — |
| `scripts/05-partner-management/import-partners.js` | Import partners from CSV into `data/customization/partners.json` (merge or replace). | `node scripts/05-partner-management/import-partners.js partners.csv [--replace]` | `data/templates/csv/partners.template.csv` |
| `scripts/05-partner-management/export-partners.js` | Export partners to CSV (stdout or file). | `node scripts/05-partner-management/export-partners.js [--out=partners.csv]` | `data/templates/csv/partners.template.csv` |
| `scripts/05-partner-management/generate-partner-token.js` | Generate or reuse a partner token (default or per-event) and print the URL with `?token=...`. | `node scripts/05-partner-management/generate-partner-token.js --partner=<slug> [--event=<eventSlug> | --season=<code> | --default] [--force]` | — |

## 06 — Misc

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/06-misc/reports/export-orders.js` | Export orders via the shared CSV service. | `node scripts/06-misc/reports/export-orders.js [--season=...] [--venue=...] [--status=paid]` | `data/templates/csv/orders-export.template.csv` |
| `scripts/orders-import-csv.js` | Import paid orders in bulk from a CSV (optionally send confirmations). | `node scripts/orders-import-csv.js --file=orders.csv [--send] [--commit]` | `data/templates/csv/orders-import.template.csv` |
| `scripts/orders-delete-csv.js` | Cancel or hard delete orders listed in a CSV. | `node scripts/orders-delete-csv.js --file=orders.csv [--commit] [--force]` | `data/templates/csv/orders-delete.template.csv` |
| `scripts/06-misc/reports/export-seats.js` | Export seats with provisioning + booking metadata. | `node scripts/06-misc/reports/export-seats.js [--season=...] [--venue=...] [--zone=...]` | `data/templates/csv/seats-export.template.csv` |
| `scripts/sentinels/pending-orders.js` | Watch pending HelloAsso orders and release holds. | `node scripts/sentinels/pending-orders.js [--max-age-minutes=60]` | — |
| `scripts/06-misc/audit-missing-seats.js` | Audit subscribers referencing seats missing from the season. | `node scripts/06-misc/audit-missing-seats.js <seasonCode> [--venue=<slug>] [--out=...]` | — |

## Admin Console

* Base URL: `/admin` (subject to `BASE_PATH`).
* Authentication: Basic auth (`ADMIN_USER`/`ADMIN_PASS`) or Bearer token (`ADMIN_TOKEN`).
* Features:
  - Server, MongoDB, PM2 and order metrics at a glance.
  - Direct download links for CSV exports.
  - Script runner with optional argument field and inline output.
  - Confirmation prompt for destructive actions (e.g. database reset).

The console relies on the metadata defined in `src/config/adminScripts.js`. Keep that file updated when adding new scripts so they appear both in the UI and in the documentation tables above.
