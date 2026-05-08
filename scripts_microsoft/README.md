# Microsoft Excel Automations

Two flavours are available depending on your environment.

---

## 1. Excel for Windows / macOS (VBA)

VBA modules mirror the BTS lifecycle:

- `02-tariff-management`
- `03-season-management`
- `04-event-management`

Samples target Excel (desktop) and rely on `MSXML2.XMLHTTP` or `WinHTTP` to call the BTS automation API.  
Populate each folder as macros become available; wire them into buttons or ribbon add-ins as needed.  
JWTs signed with `AUTOMATION_JWT_SECRET` are required to authenticate.

### Menu bootstrap (desktop)

`BTSMenu.bas` installs a top-level “BTS” menu on the Worksheet menu bar, with submenus for each lifecycle section.  
Import the module, run `InstallBtsMenu`, and bind future automations to the placeholders.

---

## 2. Excel for Microsoft 365 (web) — Office Scripts

Excel Online does not support VBA, so dedicated Office Scripts (TypeScript) live under `office_scripts/`.  
Copy each `.ts` file into Excel → Automate → `New Script`, then run from the Automate tab.

### Scripts

| Script | Purpose |
| --- | --- |
| `configureBts.ts` | Creates/updates the `BTS_Config` worksheet with base URL, JWT secret, sheet names and dry-run toggles. |
| `sendRenewInvites.ts` | Reads the `Invitations` sheet and posts invitees to `scripts/season.send-renew-invites/jobs`. |
| `importEventOrders.ts` | Reads the `EventOrders` sheet and posts orders to `scripts/event.import-orders/jobs` (dry-run by default). |
| `createMenuSheet.ts` | Generates a “BTS Menu” worksheet listing the scripts with short descriptions. |

### Configuration worksheet

Run `configureBts.ts` once to create the `BTS_Config` sheet. Key columns (aliases in dotted lowercase, e.g. `event.import.dryRun`, are also recognised). The Office Scripts currently read settings exclusively from this sheet; environment-based overrides may be added later.

- `BASE_URL`, `AUTOMATION_SECRET`, `ISSUER`, `AUDIENCE`, `SCOPES`
- `INVITES_SHEET`, `EVENT_ORDERS_SHEET`, `TARIFF_CATALOG_SHEET`, `TARIFF_PRICES_SHEET`
- `RENEW_DRY_RUN`, `EVENT_IMPORT_DRY_RUN`, `EVENT_IMPORT_FORCE`, `EVENT_IMPORT_SEND_EMAIL`
- `TARIFF_CATALOG_DRY_RUN`, `TARIFF_PRICES_DRY_RUN`, `TARIFF_PRICES_APPEND`

Re-run the script whenever you need to change values (blank arguments keep existing entries).

### Menu / launchpad

Run `createMenuSheet.ts` to produce a “BTS Menu” worksheet listing the available commands.  
Office Scripts cannot programmatically customise the ribbon; pin the scripts you use most via Automate → `...` → `Add to favourites`, or keep the menu sheet as a quick reference.

### Logs

Both automations append job metadata to a worksheet named `BTS Automations` (created automatically) so you can keep track of runs directly from Excel Online.
