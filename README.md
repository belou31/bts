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

## Spreadsheet Automations

- `scripts_libreoffice/` — Python macros for LibreOffice Calc (DEV/local flows).
- `scripts_google/` — Google Apps Script snippets for Google Sheets (INT/PROD).
- `scripts_microsoft/` — VBA scaffolding for Microsoft Excel (future extension).

Each tree mirrors the `scripts/` lifecycle categories (`02-tariff-management`, `03-season-management`, `04-event-management`) so spreadsheet tooling stays aligned with the admin “Operate” catalog.

### Shared automation secrets

Keep JWT-related secrets outside the repository in `~/.config/bts/automation.env` (or set `BTS_AUTOMATION_ENV` to another path). Example:

```
AUTOMATION_JWT_SECRET=super-secret-shared-key
AUTOMATION_JWT_ISS=libreoffice
AUTOMATION_JWT_AUD=bts-automation
```

- LibreOffice macros automatically read this file via `env_loader.py` when present. Copy `scripts_libreoffice/env_loader.py`, `menu_placeholders.py`, and any automation macro (e.g. `03-season-management/send_renew_invites.py`) into your LibreOffice `Scripts/python/` directory so they can pick it up.
- Node scripts can source the same file by prepending `-r ./tools/loadAutomationEnv.js` (alongside `-r dotenv/config` if you also load an environment-specific `.env`). For convenience set:

  ```bash
  export NODE_OPTIONS="-r dotenv/config -r ./tools/loadAutomationEnv.js"
  export DOTENV_CONFIG_PATH=.env.dev   # or .env.prod/.env.int
  ```

  Commands like `node scripts/03-season-management/import-renewers-flat.js …` will then have access to both your project `.env` and the shared automation secrets without duplicating values.

## HelloAsso Stub

- Local checkout simulator listening on `http://127.0.0.1:3005`.
- Launch with `npm run helloasso:stub` (or `node helloasso-stub/server.js`).
- Point the BTS app to it via `HELLOASSO_API_URL=http://127.0.0.1:3005`; the rest of the HelloAsso integration keeps working unchanged.
- Define `HELLOASSO_WEBHOOK_URL` (or `HELLOASSO_STUB_WEBHOOK_URL`) so the stub relays payment webhooks to the BTS `/pay/webhook` endpoint.
- Visit `http://127.0.0.1:3005/` to inspect intents and play success/failure scenarios.

## Payment Providers

- Select the active PSP through `PAYMENT_PROVIDER` (defaults to `helloasso`) while keeping the same endpoints (`/event`, `/renew`, `/pay/*`).
- HelloAsso uses the same env keys across environments; switch mode by changing `HELLOASSO_API_URL` (`http://127.0.0.1:3005` for the stub, sandbox URL for INT, production URL for PROD).
- Checkout URLs (return/back/error) and status normalisation are now delegated to the provider adapter, so routes behave identically across DEV/INT/PROD.
- The `sumup` provider is scaffolded and ready to be implemented next.
- SumUp integration expects standard OAuth credentials (`SUMUP_CLIENT_ID` / `SUMUP_CLIENT_SECRET`) plus checkout settings (`SUMUP_API_BASE`, `SUMUP_RETURN_URL`, `SUMUP_CALLBACK_URL`); run `npm run sumup:stub` to mimic the remote API locally during development.
