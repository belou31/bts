# Microsoft Excel Automations — Desktop (VBA)

VBA modules for Excel on Windows/macOS — one of the `scripts_desktop/` surfaces (alongside `../libreoffice/`, `../apple_numbers/`, and `../cli/`). For Excel Online / Microsoft 365 (web), see [`scripts_online/microsoft_excel/`](../../scripts_online/microsoft_excel) instead — Excel Online doesn't support VBA, so that's a separate TypeScript (Office Scripts) integration.

VBA modules mirror the BTS lifecycle:

- `02-tariff-management`
- `03-season-management`
- `04-event-management`

Samples target Excel (desktop) and rely on `MSXML2.XMLHTTP` or `WinHTTP` to call the BTS automation API.
Populate each folder as macros become available; wire them into buttons or ribbon add-ins as needed.
JWTs signed with `AUTOMATION_JWT_SECRET` are required to authenticate.

## Menu bootstrap (desktop)

`BTSMenu.bas` installs a top-level “BTS” menu on the Worksheet menu bar, with submenus for each lifecycle section.
Import the module, run `InstallBtsMenu`, and bind future automations to the placeholders.
