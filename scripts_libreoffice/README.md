# LibreOffice Automations

Python macros designed for LibreOffice Calc.  
They mirror the operational themes exposed in `scripts/` and the admin “Operate” page:

- `02-tariff-management` — tariff utilities.
- `03-season-management` — renewal workflows, season provisioning.
- `04-event-management` — event ticketing aides.

Each macro expects the BTS automation API to be reachable and secured with `AUTOMATION_JWT_SECRET`.  
Instead of copy/pasting files, you can symlink the entire folder into your LibreOffice profile:

```bash
mkdir -p ~/.config/libreoffice/4/user/Scripts/python
ln -sfn /home/bts/bts/scripts_libreoffice ~/.config/libreoffice/4/user/Scripts/python/scripts_libreoffice
```

LibreOffice then loads the macros straight from the repository; restart Calc whenever you add new files.  
`env_loader.py` loads shared JWT secrets from `~/.config/bts/automation.env` (override with `BTS_AUTOMATION_ENV`) so macros and CLI scripts reuse the same credentials without duplicating them in the repo.

## Add-Ons Menu Extension

LibreOffice surfaces the full BTS catalog under the global **Add-ons** menu when the extension is installed. `bts-menu-creation/registry/data/org/openoffice/Office/Addons.xcu` mirrors every 02/03/04 script:

- Commands with existing automations (e.g. “Send renewal invites”) call the real Python macro.
- All other entries call into `menu_placeholders.py`, which displays the canonical Node.js command so operators can copy/paste it until dedicated Calc automations are written.

### Logging

- All macros automatically tee their stdout/stderr into `/tmp/bts/log-<timestamp>-<name>.txt` (override directory with `BTS_LOG_DIR`).
- The LibreOffice popups include the log path so operators can open the file when troubleshooting.

To rebuild the `.oxt`:

1. From `scripts_libreoffice/bts-menu-creation/`, run `zip -r ../bts-menu.oxt META-INF registry`.
2. Install the archive in LibreOffice via `Tools → Extensions…`, then restart Calc.
3. Access the commands in `Add-Ons → BTS`. LibreOffice dispatches each entry to the macro defined in the `.xcu` file (either the working automation or the CLI helper).
