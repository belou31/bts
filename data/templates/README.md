# Script Templates

This directory gathers ready-to-copy templates for CSV, ENV, and asset files used by the operational scripts.

- `env/.env.template` — baseline environment variables required by CLI scripts.
- `csv/…` — sample structures for CSV imports/exports. Update headers if your business rules change.
- `files/plan.svg` — minimalist seating plan to help start a new venue mapping.
- `csv/seats-hold-release.template.csv` — sample for blocking/freeing seats via `seats-hold-release.js`.

Copy the relevant template next to your data, rename it, then fill it with real values before running the script.

When using the admin interface, upload the prepared files via the “Upload” buttons—files are deposited in `data/inputs`, while generated exports are published under `data/outputs`.
