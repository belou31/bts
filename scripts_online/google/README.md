# Google Sheets Automations

Apps Script implementations aligned with BTS operational themes:

- `02-tariff-management`
- `03-season-management`
- `04-event-management`

## Installation

There are two pieces:

1. **Library project** (publish once, reuse everywhere).  
   - Create a standalone Apps Script project and paste the contents of `library/BtsApp.gs`.  
   - Deploy it as a library (Resources → Libraries…) and note the Script ID.  
   - Suggested identifier: `BtsLib` (the spreadsheet code expects `BtsLib.BtsApp`).
2. **Spreadsheet-bound project** (per sheet).  
   - Open the target spreadsheet → Extensions → Apps Script.  
   - Add the library using the Script ID (identifier `BtsLib`; adjust the code if you pick another name).  
  - Create a single script file with the content of `btsMenu.gs` (auto-detects the first attached library exposing `createMenu`).
  - Save and reload the spreadsheet; a **BTS** menu appears with the 02/03/04 sections.

## Configuration

- Open the Apps Script editor → Project settings → Script properties to set the base URL (`BTS_AUTOMATION_BASE_URL`), automation secret (`BTS_AUTOMATION_SECRET` — same shared key as `AUTOMATION_JWT_SECRET`), issuer (`BTS_AUTOMATION_ISS`), audience (`BTS_AUTOMATION_AUD`), scopes (`BTS_AUTOMATION_SCOPES`), and sheet names (`BTS_AUTOMATION_SHEET_INVITES`, `BTS_AUTOMATION_SHEET_EVENT_ORDERS`, `BTS_AUTOMATION_SHEET_TARIFF_CATALOG`, `BTS_AUTOMATION_SHEET_TARIFF_PRICES`, `BTS_AUTOMATION_SHEET_CONFIG`). This is the recommended, secure path (no secrets in the spreadsheet).
- At runtime, values resolve with the following precedence:
  1. Script properties (recommended for production, secret never stored in the sheet).
  2. Keys inside the `BTS_Config` worksheet (see below) for rapid DEV setup.
  3. Library defaults.
- Scripts sign JWTs client-side and call `/api/automation`. Keep the secret aligned with your BTS instance configuration.

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
