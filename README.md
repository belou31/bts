# Belougas Ticketing System

## Admin Console

- Base path: `/admin` (automatically prefixed with `BASE_PATH` when defined).
- Authentication: set `ADMIN_TOKEN` for bearer auth and/or `ADMIN_USER`/`ADMIN_PASS` for basic auth.
- Features: operational metrics, CSV exports, and a script runner wired to the common catalog (`src/config/adminScripts.js`).

## Script Catalog & Templates

- All scripts are grouped by lifecycle stage in `src/config/adminScripts.js`.
- The admin UI mirrors this catalog, offering descriptions, notes, and runnable actions.
- Boilerplate data lives under `data/templates/`:
  - `env/.env.template` — copy to `.env` before running scripts.
  - `csv/*.template.csv` — column layouts for imports/exports.
  - `files/plan.svg` — starter seating plan to customise per venue.
- Runtime assets:
  - Upload source files (CSV, SVG, …) via the admin UI or manually into `data/inputs`.
  - Script exports are written by default into `data/outputs`.

For the full reference (commands, environment variables, templates), read [docs/scripts-catalog.md](docs/scripts-catalog.md).
