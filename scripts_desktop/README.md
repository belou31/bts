# scripts_desktop — Desktop Automations

Everything that runs on an operator's own machine rather than in a browser/cloud runtime. All surfaces share the same [`automation_client/`](../automation_client) package (config resolution, JWT signing, HTTP calls to `/api/automation`) so none of that plumbing is re-implemented per surface:

- [`libreoffice/`](libreoffice) — Python macros for LibreOffice/OpenOffice Calc, driven from a spreadsheet.
- [`microsoft_excel/`](microsoft_excel) — VBA macros for Excel desktop (Windows/macOS), driven from a spreadsheet. Placeholder stubs only, not yet implemented.
- [`apple_numbers/`](apple_numbers) — AppleScript for Apple Numbers (macOS only). Placeholder stubs only, not yet implemented.
- [`cli/`](cli) — local command line, driven from CSV files on disk (no spreadsheet needed).
- [`gui/`](gui) — Tkinter installer that sets up credentials and installs the LibreOffice macros/menu for you, instead of following the manual steps in each surface's README by hand.

Portability: `automation_client`, `cli`, and `gui` are stdlib-only Python and run unmodified on Linux, Windows, and macOS. `libreoffice`'s macro code is equally portable (LibreOffice ships the same UNO API + bundled Python everywhere) — only the manual bootstrap instructions were Linux-specific before `gui/installer.py` existed, which is exactly the gap it closes. `microsoft_excel` is Windows/macOS only by platform constraint (no VBA on Linux, no VBA-capable Excel there either). `apple_numbers` is macOS only, and structurally different from the other two — Numbers has no embedded macro language, so automation lives outside the document (AppleScript triggered from the macOS Script Menu) rather than as a macro attached to the file; see `apple_numbers/README.md` for why.

For the browser/cloud equivalents (Google Sheets, Excel Online) — which can't share this Python package since their scripting runtimes are JS/TypeScript-only — see [`../scripts_online/`](../scripts_online).

None of these surfaces talk to MongoDB directly; they're all clients of the same JWT-secured `/api/automation` surface that the admin "Operate" page also drives, so every run is logged and auditable the same way regardless of which surface triggered it.
