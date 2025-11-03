# LibreOffice Automations

Python macros designed for LibreOffice Calc.  
They mirror the operational themes exposed in `scripts/` and the admin “Operate” page:

- `02-tariff-management` — tariff utilities.
- `03-season-management` — renewal workflows, season provisioning.
- `04-event-management` — event ticketing aides.

Each macro expects the BTS automation API to be reachable and secured with `AUTOMATION_JWT_SECRET`.  
Secrets and base URL resolve with the following precedence: (1) current process environment (typically via `~/.config/bts/automation.env`), (2) overrides stored in the optional `BTS_Config` sheet, (3) hard-coded defaults for local DEV.  
Instead of copy/pasting files, you can symlink the entire folder into your LibreOffice profile:

```bash
mkdir -p ~/.config/libreoffice/4/user/Scripts/python
ln -sfn /home/bts/bts/scripts_libreoffice ~/.config/libreoffice/4/user/Scripts/python/scripts_libreoffice
```

LibreOffice then loads the macros straight from the repository; restart Calc whenever you add new files.  
`env_loader.py` loads shared JWT secrets from `~/.config/bts/automation.env` (override with `BTS_AUTOMATION_ENV`) so macros and CLI scripts reuse the same credentials without duplicating them in the repo. See `automation.env.example` in this folder for a starter file.

## Add-Ons Menu Extension

LibreOffice surfaces the full BTS catalog under the global **Add-ons** menu when the extension is installed. `bts-menu-creation/registry/data/org/openoffice/Office/Addons.xcu` mirrors every 02/03/04 script:

- Commands with working automations (tariff catalog/prices, renew invites, import event orders) call the dedicated Python macros.
- Remaining menu entries still rely on `menu_placeholders.py`, which displays the canonical Node.js command so operators can copy/paste it until dedicated Calc automations are written.

### Optional `BTS_Config` sheet

Create a hidden or visible sheet named `BTS_Config` (override with the environment variable `BTS_CONFIG_SHEET`) with two columns: `Key` and `Value`.  
Seed it with values from `BTS_Config.template.csv` if you want a quick reference.
Keys are case-insensitive; you can scope a value to a specific data sheet by appending `.<sheetname>` (lowercase, whitespace removed). Currently supported:

- `base.url` → BTS API base URL (used when `BTS_BASE_URL` is not set in the environment).
- `automation.secret` / `automation.jwt.secret` → JWT shared secret.
- `jwt.iss`, `jwt.aud`, `jwt.scopes` → JWT metadata overrides.
- `tariff.prices.slug` → default `catalogSlug` when the TariffPrices sheet omits the column.
- `tariff.prices.slug.tariffpricesseason` → per-sheet override (here for a sheet named `TariffPricesSeason`).
- `tariff.prices.venue` → default `venueSlug`.
- `tariff.prices.dryRun` / `tariff.prices.dryRun.<sheet>` → override the dry-run flag (`true`/`false`).
- `tariff.prices.append` / `tariff.prices.append.<sheet>` → override the append flag.
- Additional keys are passed to automation metadata for auditing.

### Available macros

| Macro | Sheet | Default behaviour | Environment overrides |
| --- | --- | --- | --- |
| `02-tariff-management/import_tariffs.py` | `TariffCatalog` | Posts to `tariff.import-catalog` with `dryRun=false`. | `BTS_TARIFF_CATALOG_SHEET`, `BTS_TARIFF_CATALOG_DRY_RUN`, `BTS_CONFIG_SHEET`. |
| `02-tariff-management/import_tariff_prices.py` | `TariffPrices` | Posts to `tariff.import-prices` with `dryRun=true`, `append=false`. | `BTS_TARIFF_PRICES_SHEET`, `BTS_TARIFF_PRICES_DRY_RUN`, `BTS_TARIFF_PRICES_APPEND`, `BTS_CONFIG_SHEET`. |
| `03-season-management/send_renew_invites.py` | `Invitations` | Sends renew invites (`dryRun=false`). | `BTS_BASE_URL`, `AUTOMATION_JWT_*`, `AUTOMATION_JWT_SCOPES`, `BTS_CONFIG_SHEET`. |
| `04-event-management/import_orders.py` | `EventOrders` | Posts to `event.import-orders` with `dryRun=true`, no seat overwrite (`force=false`), no email. | `BTS_EVENT_ORDERS_SHEET`, `BTS_EVENT_IMPORT_DRY_RUN`, `BTS_EVENT_IMPORT_FORCE`, `BTS_EVENT_IMPORT_SEND_EMAIL`, `BTS_CONFIG_SHEET`. |

Both macros load their configuration from the sheet name first; if the sheet is missing the active sheet is used instead.

Populate the `EventOrders` sheet with the same headers as the Google workflow (payerEmail, eventSlug/eventId, zoneKey/seatId, tariffCode, priceCents/priceEuro, quantity, etc.). The macro groups rows by `orderId`/`groupKey`, posts them to the automation API, and surfaces the job id plus a `/tmp/bts/log-*.txt` path for diagnostics.

### Logging

- All macros automatically tee their stdout/stderr into `/tmp/bts/log-<timestamp>-<name>.txt` (override directory with `BTS_LOG_DIR`).
- The LibreOffice popups include the log path so operators can open the file when troubleshooting.

To rebuild the `.oxt`:

1. From `scripts_libreoffice/bts-menu-creation/`, run `zip -r ../bts-menu.oxt META-INF registry`.
2. Install the archive in LibreOffice via `Tools → Extensions…`, then restart Calc.
3. Access the commands in `Add-Ons → BTS`. LibreOffice dispatches each entry to the macro defined in the `.xcu` file (either the working automation or the CLI helper).
