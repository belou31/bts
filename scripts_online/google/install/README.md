# Installer scripts

Automate the two manual steps documented in [`../README.md`](../README.md#installation), using Google's official `clasp` CLI:

| Script | Replaces | Run |
| --- | --- | --- |
| `install-library.js` | "Create a standalone Apps Script project, paste `BtsApp.gs`, deploy as a library" | Once, then again whenever `BtsApp.gs` changes |
| `install-sheet-menu.js` | "Extensions → Apps Script → add library → paste `btsMenu.gs` → save" | Once per spreadsheet you want the BTS menu on |

Neither writes credentials into a *spreadsheet*. `install-library.js` can optionally feed them into the *library's* own Script Properties (best-effort — see below); every spreadsheet then inherits them automatically, same as the manual path (see [`../README.md`](../README.md#configuration) for why that's where they belong).

## Prerequisites

`clasp` is a regular project dependency (`@google/clasp` in the root `package.json`) — the same `npm install` that provisions DEV/INT/PROD already installs it into `node_modules/.bin/clasp`. Both scripts resolve that local binary directly (see `lib/resolve-clasp.js`), falling back to a global `clasp` on `PATH` only if the local one is somehow missing. **No separate `npm install -g` step, on any environment.**

That also means it's **not on your shell's `PATH`** — running bare `clasp ...` in a terminal will fail with "command not found" (and there's no `apt`/system package for it — it only exists as this npm dependency). Use `npx`, which finds `node_modules/.bin/clasp` automatically, run from the repo root:

The one thing that genuinely can't be automated — it's OAuth, tied to a Google account — is authenticating it, once per machine:

```bash
cd /path/to/bts   # repo root — wherever this checkout lives
npx clasp login
```

This opens a browser for your own Google OAuth consent — your identity, not a shared secret, so it's per-operator, not something distributed like `AUTOMATION_JWT_SECRET`.

### Running these from the admin console instead of a terminal

The BTS admin panel (`00 — Client Management → Install/Update Google App BTS Library` and `→ Install Google Sheet BTS Menu`) shells out to these exact scripts — same code, same local `clasp` — but it runs as whatever OS user the BTS server process runs as (e.g. under pm2), on the server host, not the operator's laptop. `clasp login`'s default flow opens a local browser, which isn't available on a remote/headless server (the browser doing the OAuth consent is on *your* machine, not the server, so it can never reach a `localhost` callback listening on the server) — use `--no-localhost` instead. Tested sequence, on a DEV/INT/PROD server reached over SSH:

```bash
ssh <server>                    # 1. connect to the server
sudo -iu <user>                 # 2. become the OS user the BTS server runs as (e.g. belou)
cd bts                          # 3. the repo root (adjust if it lives elsewhere)
npx clasp login --no-localhost  # 4. authenticate clasp for THIS user
```

`clasp` prints a URL — open it in any browser (your laptop's is fine) and go through Google's consent screen. It then redirects to something like `http://localhost:8888/?...` — your browser will show a "can't reach this page" / "localhost n'autorise pas la connexion" error. **That's expected, not a failure**: nothing is meant to be listening there. Copy the browser's **entire address bar contents**, starting from `http://localhost...`, and paste that whole URL back into the terminal, which is waiting for it — pasting only the extracted `code=` value is not enough, clasp needs the full URL to parse it from. This is still a one-time step, but it's tied to *that user's* home directory (`~/.clasprc.json`) — if the BTS server ever runs under a different OS user (e.g. after a deployment change), it needs repeating for the new user, and running `clasp login` as yourself elsewhere won't help the admin-panel buttons since they read a different user's credentials.

---

## 1. `install-library.js`

```bash
node scripts_online/google/install/install-library.js \
  [--script-id=<existing library Script ID>] \
  [--title="BTS Automation Library"] \
  [--version-description="..."] \
  [--feed-credentials | --base-url=<url> --secret=<jwt-secret>] \
  [--iss=] [--aud=] [--scopes=] \
  [--dry-run]
```

- **First run:** omit `--script-id` — creates a new standalone project, pushes `library/BtsApp.gs`, cuts a version. Prints the Script ID and version number at the end; note both down (or set them as `BTS_GOOGLE_LIBRARY_ID` / `BTS_GOOGLE_LIBRARY_VERSION` env vars) for step 2.
- **Later runs** (pushing an updated `BtsApp.gs`): pass `--script-id=<the same ID>` so it updates the existing project — a new version is cut each time, so update the env vars / step-2 parameters to the new version number afterwards.
- **Credentials** — two alternative ways to source them for display, not both:
  - **`--feed-credentials`** — reads `APP_URL`+`BASE_PATH` and `AUTOMATION_JWT_SECRET` straight from *this server's own* `.env` (loaded via `dotenv`) — the exact secret this BTS instance already uses to validate incoming automation JWTs. No hunting the secret down by hand. This is what the admin-panel checkbox uses.
  - **`--base-url`/`--secret`** (must be given together) — explicit values, for the less common case of feeding a *different* BTS instance's credentials than the one this script happens to run next to.
  - Either way, the script **prints** the resolved values — it doesn't write them. Paste them once into `script.google.com` → the library project → Project settings → Script properties. (An earlier version tried writing them automatically via `clasp run installConfig` against the Apps Script Execution API — dropped after real-world testing failed identically with `executionApi.access` set to both `"MYSELF"` and `"ANYONE"`, most likely because clasp's default OAuth client doesn't request the scope the Execution API needs. A custom OAuth client would probably fix it, but that's a Cloud Console project + OAuth consent screen for what's ultimately one manual paste — not worth the complexity or the wider `"ANYONE"` execution surface it would otherwise require.)

## 2. `install-sheet-menu.js`

```bash
node scripts_online/google/install/install-sheet-menu.js \
  [--spreadsheet=<spreadsheet URL or ID>] \
  --library=<scriptId>:<version> \
  [--title="BTS Menu — Match J1"] \
  [--time-zone=Europe/Paris] \
  [--dry-run]
```

Installs the BTS menu on **any** spreadsheet — not specific to events; it's whatever chapters `BtsApp.gs` exposes (tariffs, seasons, events, ...).

**`--spreadsheet` omitted → creates a brand-new Google Sheet** instead of binding to an existing one, and prints its URL at the end. Useful for starting a fresh spreadsheet for a new game/event without leaving the terminal (or admin panel) to create one by hand first.

**Picking the library:** the admin console's form shows a dropdown, populated from `data/google-library-deployments.json` — every library `install-library.js` has deployed or updated, with title/version/Google account, no copy-pasting a Script ID by hand. On the CLI, `--library=<scriptId>:<version>` is the same combined form the dropdown sends; `--library-id`/`--library-version` remain available separately (or as env vars `BTS_GOOGLE_LIBRARY_ID`/`BTS_GOOGLE_LIBRARY_VERSION`) for a library not yet tracked in that registry.

`--dry-run` writes the local scratch files (`btsMenu.gs` copy + `appsscript.json`) so you can inspect them, without calling `clasp create`/`clasp push` — nothing is created in Google Drive.

### What it does

**Binding to an existing spreadsheet** (`--spreadsheet` given):
1. Extracts the spreadsheet's file ID (accepts either a full `https://docs.google.com/spreadsheets/d/...` URL or a bare ID).
2. Creates a scratch temp directory and runs `clasp create --parentId <id>` there — this both creates a new Apps Script project **and binds it to your existing spreadsheet** (it does not create a new spreadsheet). Deliberately no `--type` flag: passing `--type sheets` alongside `--parentId` has been observed to create a brand-new spreadsheet instead of binding to the one you meant, even though clasp's own design says `--type` should be ignored once `--parentId` is given.

**Creating a new spreadsheet** (`--spreadsheet` omitted):
1. Runs `clasp create --type sheets --title <title>` — this is what creates a brand-new Google Sheet plus its bound Apps Script project (the same command *without* `--parentId` that the bullet above deliberately avoids).
2. Reads the new spreadsheet's file ID back out of the resulting `.clasp.json`'s `parentId` field, and prints its URL at the end.

Either way, both paths then:
3. Remove clasp's default `Code.js` scaffold stub (would otherwise register a second, conflicting `onOpen()`).
4. Copy `../btsMenu.gs` in, and write an `appsscript.json` manifest declaring the `BtsLib` library dependency at the version you specified.
5. Run `clasp push --force`.

The local scratch directory is printed at the end and left in place (path under your OS temp dir) — safe to delete, or keep it if you want a local `clasp`-managed checkout to edit that spreadsheet's bound script later instead of the Apps Script web editor.

### After running

Reload the spreadsheet. The **BTS** menu should appear, with **00 — Diagnostics → Vérifier configuration** as the first item — run that to confirm the spreadsheet is correctly inheriting the library's credentials (it should report every value as coming from "Script Properties de la bibliothèque BtsApp", not the sheet or a default).

---

## Troubleshooting

- **`"clasp" introuvable`** — `node_modules/.bin/clasp` is missing; run `npm install` at the repo root (it's a real dependency now, no global install needed).
- **`No credentials found.`** (from clasp itself) — run `npx clasp login` first, from the repo root (see the admin-console note above if this is running server-side).
- **`clasp create ... a échoué`** — most often the Apps Script API isn't enabled for your account: visit [script.google.com/home/usersettings](https://script.google.com/home/usersettings) and turn it on, or the account running `clasp login` doesn't have edit access to the target spreadsheet.
- **`--feed-credentials requiert APP_URL et AUTOMATION_JWT_SECRET...`** — this server's own `.env` is missing one of those; `--feed-credentials` deliberately refuses to proceed with a half-empty credential set rather than print a broken config.
- **Diagnostics menu shows "valeur par défaut" / "(non défini)" instead of the library source** — the library's own Script Properties haven't been pasted in yet, or were pasted into the wrong project; open the *library* project itself (not a spreadsheet's bound script) → Project settings → Script properties, and paste the values `install-library.js` printed.
