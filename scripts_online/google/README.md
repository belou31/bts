# Google Sheets Automations

Apps Script implementations aligned with BTS operational themes:

- `02-tariff-management`
- `03-season-management`
- `04-event-management`

## Installation

There are two pieces. Both can be done by hand (below) or automated — see "Installer" further down, which covers both steps including feeding the library its credentials.

1. **Library project** (publish once, reuse everywhere — every spreadsheet's BTS menu attaches this same library).
   - Create a standalone Apps Script project and paste the contents of `library/BtsApp.gs`.
   - Deploy it as a library (Resources → Libraries…) and note the Script ID.
   - Suggested identifier: `BtsLib` (the spreadsheet code expects `BtsLib.BtsApp`).
   - **Set credentials here** — see Configuration below. This is the one place they need to be entered; every spreadsheet that attaches the library inherits them automatically.
2. **Spreadsheet-bound project** (one per spreadsheet).
   - Open the target spreadsheet → Extensions → Apps Script.
   - Add the library using the Script ID (identifier `BtsLib`; adjust the code if you pick another name).
   - Create a single script file with the content of `btsMenu.gs` (auto-detects the first attached library exposing `createMenu`).
   - Save and reload the spreadsheet; a **BTS** menu appears with the Diagnostics/02/03/04 sections.
   - **No credential setup needed here** in the common case — see Configuration below. `install/install-sheet-menu.js` automates this entire step (see "Installer" below).

## Configuration

**Set credentials once, on the library project — not per spreadsheet.** Open the *library's own* Apps Script editor (the standalone project from step 1, not any individual spreadsheet's bound script) → Project settings → Script properties, and set the base URL (`BTS_AUTOMATION_BASE_URL`), automation secret (`BTS_AUTOMATION_SECRET` — same shared key as `AUTOMATION_JWT_SECRET`), issuer (`BTS_AUTOMATION_ISS`), audience (`BTS_AUTOMATION_AUD`), and scopes (`BTS_AUTOMATION_SCOPES`).

This isn't just a convention — it's how Apps Script actually behaves: `PropertiesService.getScriptProperties()`, called from code that lives in the library project (which is all of `BtsApp.gs`), always resolves to *that library's own* property store, completely isolated from whatever spreadsheet is calling it ([Apps Script Properties Service docs](https://developers.google.com/apps-script/guides/properties) — properties are never shared between scripts). Setting `BTS_AUTOMATION_SECRET` etc. on an individual spreadsheet's *bound* script's Project settings has no effect on what the library reads — it's a different, unrelated property store. This is why one library-level setup covers every spreadsheet with zero per-spreadsheet credential entry.

At runtime, values resolve with the following precedence:
1. **Script properties on the library project** (set once, shared by every spreadsheet — the recommended path, secret never stored in any spreadsheet).
2. Keys inside that spreadsheet's own `BTS_Config` worksheet (see below) — per-spreadsheet overrides/fallback, e.g. a spreadsheet that needs a different base URL, or rapid DEV setup before the library is configured.
3. Library defaults hardcoded in `BtsApp.gs`.

Also configurable via Script Properties or `BTS_Config`: sheet names (`BTS_AUTOMATION_SHEET_INVITES`, `BTS_AUTOMATION_SHEET_EVENT_ORDERS`, `BTS_AUTOMATION_SHEET_TARIFF_CATALOG`, `BTS_AUTOMATION_SHEET_TARIFF_PRICES`, `BTS_AUTOMATION_SHEET_CONFIG`).

Scripts sign JWTs client-side and call `/api/automation`. Keep the secret aligned with your BTS instance configuration.

### Checking what's actually configured

Run **BTS → 00 — Diagnostics → Vérifier configuration** from any spreadsheet. It reports, for base URL / secret / issuer / audience, the resolved value (secret shown masked) and which tier it came from — the library's Script Properties, this spreadsheet's `BTS_Config` sheet, or a hardcoded default — so a misconfiguration (e.g. credentials mistakenly entered on the spreadsheet's own Project settings instead of the library's) is visible immediately instead of failing silently.

## Installer

Both installation steps above can be automated with `clasp`, Google's official CLI (a real project dependency — see `install/README.md`'s Prerequisites) — the manual Extensions → Apps Script → paste-and-save ritual becomes one command each. Both are also exposed as buttons in the BTS admin console, under **00 — Client Management**.

```bash
# one-time per machine — clasp itself is already installed via npm install at the repo
# root, but only locally (node_modules/.bin/clasp, not on PATH) — run it via npx, from
# the repo root:
npx clasp login

# step 1, once (or again to push an update to BtsApp.gs — pass --script-id to reuse the same project)
node scripts_online/google/install/install-library.js \
  [--feed-credentials]   # optional: reads BASE_URL/secret from THIS server's own .env and
                          # prints them ready to paste (also records the deployment in
                          # data/google-library-deployments.json — see step 2)

# step 2, once per new spreadsheet — the admin console offers a dropdown built from
# that registry instead; on the CLI, the combined form is the same:
node scripts_online/google/install/install-sheet-menu.js \
  --spreadsheet=<spreadsheet URL or ID> \
  --library=<scriptId>:<version>   # printed by step 1
```

`install-library.js` creates (or updates) the standalone library project and pushes `BtsApp.gs`, printing the resulting Script ID + version for use in step 2. `--feed-credentials` additionally reads `APP_URL`/`AUTOMATION_JWT_SECRET` from this server's own `.env` and prints them ready to paste — no more than that. (An automatic write via `clasp run` was tried and dropped after real-world testing failed regardless of `executionApi` access level; see `install/README.md` for details.) Paste them once into Project settings → Script properties on the library project.

`install-sheet-menu.js` creates a new Apps Script project bound to that spreadsheet (`clasp create --parentId ...` — deliberately no `--type`, see `install/README.md` for why) and pushes `btsMenu.gs` plus a manifest declaring the `BtsLib` library dependency (`clasp push`). No credentials are written by this one — the bound project inherits everything from the library's Script Properties. Reload the spreadsheet afterwards; the **BTS** menu appears the same as with the manual steps.

See `install/README.md` for details, prerequisites, and troubleshooting.

## Usage

All workflows append a row to the **BTS Automations** sheet containing a timestamp, job id, status, record count, and the originating sheet URL.

### Optional `BTS_Config` sheet

Add a tab named `BTS_Config` (or your custom name stored in the Script Property `BTS_AUTOMATION_SHEET_CONFIG`) with two columns: `Key` and `Value`.  
Start from the example `scripts_desktop/libreoffice/BTS_Config.template.csv` if you need a reference table.
Keys are case-insensitive and can be scoped per sheet by suffixing `.<sheetName>` (whitespace removed, lowercase). Supported entries today:

| Key | Description |
| --- | --- |
| `base.url` | Default BTS API base URL (fallback when the script property is empty). |
| `automation.secret` | JWT shared secret fallback. |
| `jwt.iss` / `jwt.aud` / `jwt.scopes` | JWT metadata overrides (issuer, audience, scopes). |
| `renew.dryRun` | Override the renew invitation dry-run flag (`true`/`false`). |
| `event.import.dryRun` | Override event import dry-run. |
| `event.import.force` | Override event import force flag. |
| `event.import.sendEmail` | Override event import email dispatch. |
| `tariff.catalog.dryRun` | Override tariff catalog dry-run. |
| `tariff.prices.dryRun` | Override tariff price dry-run. |
| `tariff.prices.append` | Override tariff price append behaviour. |
| `tariff.prices.slug` | Default `catalogSlug` when the TariffPrices sheet leaves the column empty. |
| `tariff.prices.slug.<sheet>` | Per-sheet slug override (use sheet name without spaces). |
| `tariff.prices.venue` | Default `venueSlug` for tariff prices. |
| `tariff.prices.venue.<sheet>` | Per-sheet venue override. |

This keeps catalog identifiers visible alongside the spreadsheet while avoiding per-row duplication.

### Tariff catalog import

1. Populate the `TariffCatalog` sheet (configurable) with headers `code`, `label`, and optional `requiresField`, `fieldLabel`, `requiresInfo`, `active`, `sortOrder`.
2. Run **BTS → 02 — Tariff Management → Importer catalogue tarifs**.  
   The library posts to `scripts/tariff.import-catalog/jobs`. Dry-run defaults to the Script Property `BTS_AUTOMATION_TARIFF_CATALOG_DRY_RUN` but can be overridden via `tariff.catalog.dryRun` (and `.tariffcatalogsheet`) entries in `BTS_Config`.

### Tariff price catalog import

1. Populate the `TariffPrices` sheet with headers `catalogSlug`, `venueSlug` (optional), `zoneKey`, `tariffCode`, and either `priceCents` or `priceEuro` (plus optional `currency`).
2. Run **BTS → 02 — Tariff Management → Importer catalogue prix**.  
   Payloads are sent to `scripts/tariff.import-prices/jobs`. `BTS_Config` can provide defaults for `catalogSlug` / `venueSlug` (`tariff.prices.slug`, `tariff.prices.venue`) and override the dry-run / append flags (`tariff.prices.dryRun`, `tariff.prices.append`), falling back to Script Properties (`BTS_AUTOMATION_TARIFF_PRICES_DRY_RUN`, `BTS_AUTOMATION_TARIFF_PRICES_APPEND`) when absent.

### Renew invitations

1. Populate the `Invitations` sheet with headers `email`, `renewUrl`, and optional `firstName`, `lastName`, `seats`.
2. Run **BTS → 03 — Season Management → Envoyer invitations**.  
   This posts to `scripts/season.send-renew-invites/jobs`; the dry-run value honours `renew.dryRun` from `BTS_Config` (fallback to Script Property `BTS_AUTOMATION_RENEW_DRY_RUN`, default `false`).

### Event order import

1. Populate the `EventOrders` sheet (name configurable via Script Property `BTS_AUTOMATION_SHEET_EVENT_ORDERS`) with one row per ticket, using headers such as:
   `orderId`, `groupKey`, `eventSlug` (or `eventId`), `payerEmail`, `payerFirstName`, `payerLastName`,  
   line details `seatId`, `zoneKey`, `tariffCode`, `priceCents` (or `priceEuro`), `quantity`, `holderFirstName`, `holderLastName`, and optional metadata (`status`, `createdAt`, `providerName`, `eventName`, `eventStartsAt`, `eventNotes`…).
2. Run **BTS → 04 — Event Management → Importer commandes (dry-run)**.  
   The library posts to `scripts/event.import-orders/jobs`. Use `event.import.dryRun`, `event.import.force`, `event.import.sendEmail` in `BTS_Config` to override the Script Property defaults (`BTS_AUTOMATION_EVENT_IMPORT_DRY_RUN`, `BTS_AUTOMATION_EVENT_IMPORT_FORCE`, `BTS_AUTOMATION_EVENT_IMPORT_SEND_EMAIL`).
3. Inspect the Automation job in BTS for detailed logs (missing seats, already booked, email delivery issues, etc.).

## Extending

- Additional automations belong in the library project: add new methods to `BtsApp` in `library/BtsApp.gs` (e.g. `sendEventInvitesFromSheet`) and expose them via `getMenuSections`.
- Update `btsMenu.gs` to call the new library methods or tweak the menu structure returned by `BtsLib.BtsApp.getMenuSections()`.
- Future scripts should follow the same pattern: gather sheet data, build a payload, call the automation API, append a log row, and surface a confirmation.
- Toggle the default dry-run behaviour by editing `DEFAULTS.renewDryRun` / `DEFAULTS.eventImportDryRun` in `BtsApp.gs` before publishing a new library version.
