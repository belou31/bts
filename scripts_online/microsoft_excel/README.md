# Microsoft Excel Automations — Online (Office Scripts)

Office Scripts (TypeScript) for Excel on Microsoft 365 (web) — Excel Online doesn't support VBA, so this lives separately from the desktop VBA integration at [`scripts_desktop/microsoft_excel/`](../../scripts_desktop/microsoft_excel).

Copy each `.ts` file into Excel → Automate → `New Script`, then run from the Automate tab.

## Scripts

| Script | Purpose |
| --- | --- |
| `configureBts.ts` | Creates/updates the `BTS_Config` worksheet with base URL, JWT secret, sheet names and dry-run toggles. |
| `sendRenewInvites.ts` | Reads the `Invitations` sheet and posts invitees to `scripts/season.send-renew-invites/jobs`. |
| `importEventOrders.ts` | Reads the `EventOrders` sheet and posts orders to `scripts/event.import-orders/jobs` (dry-run by default). |
| `createMenuSheet.ts` | Generates a “BTS Menu” worksheet listing the scripts with short descriptions. |

## Configuration worksheet

Run `configureBts.ts` once to create the `BTS_Config` sheet. Key columns (aliases in dotted lowercase, e.g. `event.import.dryRun`, are also recognised). The Office Scripts currently read settings exclusively from this sheet; environment-based overrides may be added later.

- `BASE_URL`, `AUTOMATION_SECRET`, `ISSUER`, `AUDIENCE`, `SCOPES`
- `INVITES_SHEET`, `EVENT_ORDERS_SHEET`, `TARIFF_CATALOG_SHEET`, `TARIFF_PRICES_SHEET`
- `RENEW_DRY_RUN`, `EVENT_IMPORT_DRY_RUN`, `EVENT_IMPORT_FORCE`, `EVENT_IMPORT_SEND_EMAIL`
- `TARIFF_CATALOG_DRY_RUN`, `TARIFF_PRICES_DRY_RUN`, `TARIFF_PRICES_APPEND`

Re-run the script whenever you need to change values (blank arguments keep existing entries).

## Menu / launchpad

Run `createMenuSheet.ts` to produce a “BTS Menu” worksheet listing the available commands.
Office Scripts cannot programmatically customise the ribbon; pin the scripts you use most via Automate → `...` → `Add to favourites`, or keep the menu sheet as a quick reference.

## Logs

Both automations append job metadata to a worksheet named `BTS Automations` (created automatically) so you can keep track of runs directly from Excel Online.
