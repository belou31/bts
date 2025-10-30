# Google Sheets Automations

Apps Script implementations aligned with BTS operational themes:

- `02-tariff-management`
- `03-season-management`
- `04-event-management`

Embed the desired `.gs` script into your spreadsheet (Extensions → Apps Script).  
Scripts authenticate against `/api/automation` using JWTs signed with `AUTOMATION_JWT_SECRET` and must be adapted for each tenant (base URL, scopes, dry-run toggles).
Each script exposes an `onOpen` hook that registers a “BTS” menu mirroring the lifecycle sections so operators trigger automations consistent with the admin Operate catalog.
