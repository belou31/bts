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
