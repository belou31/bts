# Script Catalog & Admin Console

The repository consolidates all operational scripts under a shared catalog (`src/config/adminScripts.js`) and exposes them through the `/admin` console. Scripts are grouped by lifecycle stage so you can trigger them from the UI or from the CLI.

Each entry below references the canonical command, required environment variables, and the template files you can copy before running the script.

Unless noted otherwise, scripts look for input assets in `data/inputs` (where the admin upload stores files) and write their CSV exports to `data/outputs`.

## 00 — Baseline & Reset

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/00-baseline-reset/reset-db.js` | Drop the MongoDB database defined in `.env`. Requires `--force`. | `node scripts/00-baseline-reset/reset-db.js --force` | `data/templates/env/.env.template` |

## 01 — Initialization (DB, Venue, Season)

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/01-initialization/check-env.js` | Validate the core `.env` configuration (APP_URL, HelloAsso, etc.). | `node scripts/01-initialization/check-env.js` | `data/templates/env/.env.template` |
| `scripts/01-initialization/seed-dev.js` | Seed a lightweight development dataset (season, zones, seats, tariffs). | `node scripts/01-initialization/seed-dev.js` | `data/templates/env/.env.template` |
| `scripts/01-initialization/seed-zones.js` | Import zones from CSV for a season/venue. | `node scripts/01-initialization/seed-zones.js --csv=zones.csv --venue=<slug>` | `data/templates/env/.env.template`, `data/templates/csv/zones.template.csv` |
| `scripts/01-initialization/venues/register-venue.js` | Register a venue (slug + name). | `node scripts/01-initialization/venues/register-venue.js <slug> "<Venue>"` | `data/templates/env/.env.template`, `data/templates/files/plan.svg` |
| `scripts/01-initialization/venues/register-venue-with-plan.js` | Copy an SVG plan and register the venue in one go. | `node scripts/01-initialization/venues/register-venue-with-plan.js <slug> "<Venue>" plan.svg` | `data/templates/env/.env.template`, `data/templates/files/plan.svg` |
| `scripts/01-initialization/venues/import-seats-from-svg.js` | Import seat templates from an SVG plan. | `node scripts/01-initialization/venues/import-seats-from-svg.js <slug> plan.svg` | `data/templates/env/.env.template`, `data/templates/files/plan.svg` |
| `scripts/01-initialization/venues/instantiate-seats-for-season.js` | Clone seat templates into a season-specific collection. | `node scripts/01-initialization/venues/instantiate-seats-for-season.js <season> <slug>` | `data/templates/env/.env.template` |
| `scripts/01-initialization/import-subscribers-flat.js` | Upsert subscribers from a “flat” CSV (1 seat per row). | `node scripts/01-initialization/import-subscribers-flat.js subscribers.csv <season> --venue=<slug>` | `data/templates/env/.env.template`, `data/templates/csv/subscribers-flat.template.csv` |

## 02 — Season Generation & Renewal

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/02-season-generation/upsert-season.js` | Upsert season metadata and phases. | `node scripts/02-season-generation/upsert-season.js <seasonCode> --name="..." --venue=<slug>` | `data/templates/env/.env.template` |
| `scripts/02-season-generation/renewal/provision-seats.js` | Tag previous-season seats as provisioned (dry-run by default). | `node scripts/02-season-generation/renewal/provision-seats.js <seasonCode> --venue=<slug> [--apply]` | `data/templates/env/.env.template` |
| `scripts/02-season-generation/exports/export-renew-groups.js` | Export grouped renewal tokens for emailing. | `node scripts/02-season-generation/exports/export-renew-groups.js <seasonCode> --venue=<slug> --base=<https://host/bts>` | `data/templates/env/.env.template`, `data/templates/csv/renew-groups.template.csv` |
| `scripts/02-season-generation/exports/export-renew-seats.js` | Export renewal seats with signed URLs. | `node scripts/02-season-generation/exports/export-renew-seats.js <seasonCode> [--base=...]` | `data/templates/env/.env.template`, `data/templates/csv/renew-seats.template.csv` |

## 03 — Event Management & Tariffs

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/03-event-management/events/create.js` | Create an event bound to a season and venue. | `node scripts/03-event-management/events/create.js --slug=... --name="..." --date=ISO --season=<code> --venue=<slug>` | `data/templates/env/.env.template` |
| `scripts/03-event-management/events/set-onsale.js` | Toggle ticket sales for an event. | `node scripts/03-event-management/events/set-onsale.js --event=<slug|ObjectId> --open` | `data/templates/env/.env.template` |
| `scripts/03-event-management/tariffs/import-catalog.js` | Import the master tariff catalog. | `node scripts/03-event-management/tariffs/import-catalog.js tariff_catalog.csv` | `data/templates/csv/tariff-catalog.template.csv` |
| `scripts/03-event-management/pricing/import-zone-tariffs.js` | Import price matrix per zone. | `node scripts/03-event-management/pricing/import-zone-tariffs.js <season> <slug> prices.csv` | `data/templates/csv/zone-tariffs.template.csv` |
| `scripts/03-event-management/pricing/export-zone-tariffs.js` | Export the current price matrix. | `node scripts/03-event-management/pricing/export-zone-tariffs.js <season> <slug> --out=prices.csv` | `data/templates/env/.env.template` |

## 04 — Admin & Monitoring

| Script | Purpose | Command | Templates |
| --- | --- | --- | --- |
| `scripts/04-admin-monitoring/reports/export-orders.js` | Export orders using the shared CSV service. | `node scripts/04-admin-monitoring/reports/export-orders.js [--season=...] [--venue=...] [--status=paid]` | `data/templates/csv/orders-export.template.csv` |
| `scripts/04-admin-monitoring/reports/export-seats.js` | Export seats with booking metadata. | `node scripts/04-admin-monitoring/reports/export-seats.js [--season=...] [--venue=...] [--zone=...]` | `data/templates/csv/seats-export.template.csv` |
| `scripts/04-admin-monitoring/reports/export-subscribers.js` | Export subscribers for a season/venue. | `node scripts/04-admin-monitoring/reports/export-subscribers.js [--season=...] [--venue=...] [--activeOnly]` | `data/templates/csv/subscribers-export.template.csv` |
| `scripts/04-admin-monitoring/orders-resend-confirmation.js` | Resend confirmation emails from a CSV list (dry-run without `--commit`). | `node scripts/04-admin-monitoring/orders-resend-confirmation.js --file=orders.csv [--commit]` | `data/templates/csv/orders-resend.template.csv` |
| `scripts/04-admin-monitoring/sentinels/pending-orders.js` | Monitor HelloAsso pending orders and release holds. | `node scripts/04-admin-monitoring/sentinels/pending-orders.js [--sinceMinutes=180]` | `data/templates/env/.env.template` |
| `scripts/04-admin-monitoring/audit-missing-seats.js` | Detect subscribers referencing seats missing in the season catalog. | `node scripts/04-admin-monitoring/audit-missing-seats.js <seasonCode> [venueSlug]` | `data/templates/env/.env.template` |

## Admin Console

* Base URL: `/admin` (subject to `BASE_PATH`).
* Authentication: Basic auth (`ADMIN_USER`/`ADMIN_PASS`) or Bearer token (`ADMIN_TOKEN`).
* Features:
  - Server, MongoDB, PM2 and order metrics at a glance.
  - Direct download links for CSV exports.
  - Script runner with optional argument field and inline output.
  - Confirmation prompt for destructive actions (e.g. database reset).

The console relies on the metadata defined in `src/config/adminScripts.js`. Keep that file updated when adding new scripts so they appear both in the UI and in the documentation tables above.
