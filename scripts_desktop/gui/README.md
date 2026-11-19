# BTS Desktop Installer

A Tkinter GUI to set up the other two `scripts_desktop/` surfaces — no manual symlinking, path-hunting, or `unopkg` invocations required. Stdlib-only (`tkinter`), same constraint as [`automation_client/`](../../automation_client) and [`../cli/`](../cli).

```bash
python3 scripts_desktop/gui/installer.py
```

On Ubuntu, `tkinter` needs a separate system package if it isn't already present: `sudo apt install python3-tk`. It ships by default with the python.org installers on Windows and macOS.

## What it does

**Credentials tab** — writes `AUTOMATION_JWT_SECRET`/`BTS_BASE_URL`/etc. to the OS-idiomatic `automation.env` location (`automation_client.default_env_path()` — `~/.config/bts/` on Linux, `%APPDATA%\bts\` on Windows, `~/Library/Application Support/bts/` on macOS), and a **Test connection** button that calls the read-only `GET /api/automation/scripts` endpoint (no job is submitted) to confirm the secret and URL actually work.

**LibreOffice tab** — copies `automation_client/`, `scripts_desktop/libreoffice/`, and `scripts_desktop/cli/` into the detected (or manually chosen) LibreOffice `Scripts/python/` profile directory, and runs `unopkg add` to install the Add-ons menu extension (`bts-menu.oxt`). `unopkg` is auto-detected via `PATH` and common per-OS install locations; browse manually if it isn't found. LibreOffice must be closed before installing the extension.

**Excel (VBA) tab** — informational only. Importing a `.bas` module into a workbook needs COM automation (`pywin32`) on Windows or AppleScript on Mac — more moving parts than the 15-second manual `Alt+F11 → File → Import File` step, so this tab just points at the source folder and shows the steps rather than automating them.

## Why not automate the Excel import too

Keeping the installer stdlib-only was a deliberate constraint carried over from `automation_client`/`cli` (so it runs with zero `pip install` anywhere, including inside restricted environments). Automating the VBA import would break that for one tab's worth of convenience on a step that's already trivial by hand. If that trade-off changes, `win32com.client` (Windows) and `appscript`/`osascript` (Mac) are the respective mechanisms — but they're per-OS, so it stops being "one code path."
