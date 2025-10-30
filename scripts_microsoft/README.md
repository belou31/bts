# Microsoft Excel Automations

VBA macros that replicate BTS operational tooling for:

- `02-tariff-management`
- `03-season-management`
- `04-event-management`

These samples target Excel (desktop) and rely on `MSXML2.XMLHTTP` or `WinHTTP` to call the BTS automation API.  
Populate each folder as macros become available; wire them into buttons or ribbon add-ins as needed.  
JWTs signed with `AUTOMATION_JWT_SECRET` are required to authenticate.

## Menu bootstrap

`BTSMenu.bas` installs a top-level “BTS” menu on the Worksheet menu bar, with submenus for each lifecycle section. Import the module, run `InstallBtsMenu`, and bind future automations to the placeholders.

