# Google Sheets Automations

Apps Script implementations aligned with BTS operational themes:

- `02-tariff-management`
- `03-season-management`
- `04-event-management`

## Installation

There are two pieces:

1. **Library project** (publish once, reuse everywhere).  
   - Create a standalone Apps Script project and paste the contents of `scripts_google/library/BtsApp.gs`.  
   - Deploy it as a library (Resources → Libraries…) and note the Script ID.  
   - Suggested identifier: `BtsLib` (the spreadsheet code expects `BtsLib.BtsApp`).
2. **Spreadsheet-bound project** (per sheet).  
   - Open the target spreadsheet → Extensions → Apps Script.  
   - Add the library using the Script ID (identifier `BtsLib`; adjust the code if you pick another name).  
   - Create a single script file with the content of `scripts_google/btsMenu.gs`.
   - Save and reload the spreadsheet; a **BTS** menu appears with the 02/03/04 sections plus “Configure…”.

## Configuration

- Choose **BTS → Configure…** to set the base URL of your BTS instance, the JWT secret (`AUTOMATION_JWT_SECRET`), and the sheet names used for renewals (`Invitations`) and event orders (`EventOrders`). Issuer, audience, and scopes default to `google-sheets`, `bts-automation`, and `automation:jobs:write automation:jobs:run` respectively but can be overwritten.
- Configuration is stored in Script Properties. Editors of the sheet share the same settings; update them whenever the secret rotates.
- Scripts sign JWTs client-side and call `/api/automation`. Ensure the shared secret matches the one configured for `season.send-renew-invites` in BTS.

## Usage

### Renew invitations

1. Populate the `Invitations` sheet with headers `email`, `renewUrl`, and optional `firstName`, `lastName`, `seats`.
2. Run **BTS → 03 — Season Management → Envoyer invitations**.  
   This posts to `scripts/season.send-renew-invites/jobs` with `dryRun=false` (toggle `DEFAULTS.renewDryRun` in `BtsApp.gs` if you want a sandbox mode).
3. Each execution appends a row to **BTS Automations** (timestamp, script id, job id, status, record count, sheet URL).

### Event order import

1. Populate the `EventOrders` sheet (name configurable via **Configure…**) with one row per ticket, using headers such as:
   `orderId`, `groupKey`, `eventSlug` (or `eventId`), `payerEmail`, `payerFirstName`, `payerLastName`,  
   line details `seatId`, `zoneKey`, `tariffCode`, `priceCents` (or `priceEuro`), `quantity`, `holderFirstName`, `holderLastName`, and optional metadata (`status`, `createdAt`, `providerName`, `eventName`, `eventStartsAt`, `eventNotes`…).
2. Run **BTS → 04 — Event Management → Importer commandes (dry-run)**.  
   The library posts to `scripts/event.import-orders/jobs` with `dryRun=true` by default (change `DEFAULTS.eventImportDryRun` to commit).
3. Results (created/updated/skipped) are logged in **BTS Automations**; inspect the Automation job in BTS for detailed logs and conflicts (missing seats, already booked, etc.).

## Extending

- Additional automations belong in the library project: add new methods to `BtsApp` in `library/BtsApp.gs` (e.g. `sendEventInvitesFromSheet`) and expose them via `getMenuSections`.
- Update `btsMenu.gs` to call the new library methods or tweak the menu structure returned by `BtsLib.BtsApp.getMenuSections()`.
- Future scripts should follow the same pattern: gather sheet data, build a payload, call the automation API, append a log row, and surface a confirmation.
- Toggle the default dry-run behaviour by editing `DEFAULTS.renewDryRun` / `DEFAULTS.eventImportDryRun` in `BtsApp.gs` before publishing a new library version.
