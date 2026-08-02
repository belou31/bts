# Apple Numbers Automations — Desktop (AppleScript)

Placeholder for macOS Numbers — one of the `scripts_desktop/` surfaces, alongside [`../libreoffice/`](../libreoffice) (Python macros) and [`../microsoft_excel/`](../microsoft_excel) (VBA). Same placeholder status as `../microsoft_excel/`: stubs only, HTTP + JWT signing not implemented yet.

## Why this looks different from the other two

Numbers has no embedded macro language — no Basic/Python macro living inside the document the way LibreOffice or Excel have. macOS automation instead works *around* the app, via **AppleScript** (or JavaScript for Automation, JXA). A script lives outside the `.numbers` file and gets triggered from the macOS global **Script Menu** — a scroll icon in the menu bar, shown when Numbers is frontmost, once enabled in Script Editor → Preferences → General. The script then reads/writes the currently-open document's cells via Numbers' AppleScript dictionary.

Practically:

- **Install**: save a script as `.scpt` (via Script Editor) into `~/Library/Scripts/Applications/Numbers/`. No build step, no extension to package — dropping the file in that folder is the entire "install."
- **HTTP + JWT**: no Python available, so this can't share `automation_client`. AppleScript shells out instead — `do shell script "curl ..."` for the HTTP call, `do shell script "openssl dgst -sha256 -hmac ..."` for HMAC-SHA256 JWT signing. Both `curl` and `openssl` ship with macOS by default, so — like `automation_client` and the LibreOffice macros — this needs zero extra installs.
- **macOS only**: Numbers doesn't run on Linux or Windows, so unlike the LibreOffice surface, there's no cross-platform story here by construction.

## Available scripts

| Script | Status |
| --- | --- |
| `ExportTariffs.applescript` | Stub — see the file for the intended shape (read `AUTOMATION_JWT_SECRET`, POST to `tariff.export-catalog`, write results back into the sheet). |

## To install once implemented

1. Open Script Editor, paste the script's contents, save as `~/Library/Scripts/Applications/Numbers/<name>.scpt`.
2. Script Editor → Preferences → General → enable "Show Script menu in menu bar" (one-time, if not already on).
3. With a `.numbers` document open, the script appears under the Script Menu (scroll icon) → Numbers.
