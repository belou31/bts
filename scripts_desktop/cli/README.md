# BTS Local Command Line

The "local command line" surface of `scripts_desktop/` — no spreadsheet needed, no direct database access. `bts_cli.py` reads a CSV off disk, builds the exact same job payload the LibreOffice/Excel macros build from a sheet, and posts it to the BTS automation API via the shared [`automation_client/`](../../automation_client) package (same JWT signing, same job queue, same audit trail — nothing here talks to MongoDB directly).

## Setup

Same credentials as the other desktop surfaces — see [../../README.md#shared-automation-secrets](../../README.md). Either export the variables directly, or drop them in `~/.config/bts/automation.env`:

```
AUTOMATION_JWT_SECRET=super-secret-shared-key
BTS_BASE_URL=https://billetterie-test.belougas.fr/bts
```

No install step: the script is stdlib-only (same constraint as the LibreOffice macros), run it directly with `python3`.

## Discovering commands

Don't guess subcommand names — `list` queries the live automation API (`GET /api/automation/scripts`) rather than a hardcoded/copy-pasted list, so it can never drift from what the server actually supports:

```bash
python3 scripts_desktop/cli/bts_cli.py list
```

Grouped by chapter (matching admin/operate), one line per script: the exact `bts_cli.py` invocation and its description. A script only shows up here once it has both a registered automation task *and* a matching CLI subcommand below — if a task exists server-side but no CLI command wraps it yet, `list` marks it `[not available via bts_cli]` instead of hiding the gap.

## Commands

```bash
python3 scripts_desktop/cli/bts_cli.py tariff import-catalog data/inputs/tariff_catalog.csv
python3 scripts_desktop/cli/bts_cli.py tariff export-catalog --out=data/outputs/tariff_catalog.csv
python3 scripts_desktop/cli/bts_cli.py tariff export-zone-tariffs 2025-2026 patinoire-blagnac --out=data/outputs/prices.csv
python3 scripts_desktop/cli/bts_cli.py tariff import-prices season-game data/inputs/prices.csv --venue=patinoire-blagnac
python3 scripts_desktop/cli/bts_cli.py season send-renew-invites data/inputs/renew-groups.csv --season=2025-2026 --deadline=2025-08-31T23:00:00Z
python3 scripts_desktop/cli/bts_cli.py event import-orders data/inputs/event-orders.csv
python3 scripts_desktop/cli/bts_cli.py jobs status <job-id>
```

Run any command with `--help` for its exact CSV headers and options.

### Dry-run

Each task keeps the same default the LibreOffice macro uses for the same job (documented in [../libreoffice/README.md](../libreoffice/README.md#available-macros)):

| Command | Default | Override |
| --- | --- | --- |
| `tariff import-catalog` | live (`dryRun=false`) | `--dry-run` to preview instead |
| `tariff import-prices` | dry-run | `--commit` to apply |
| `season send-renew-invites` | live (`dryRun=false`) | `--dry-run` to preview instead |
| `event import-orders` | dry-run | `--commit` to apply |

`--dry-run` and `--commit` are mutually exclusive; omit both to use the task's default.

## CSV formats

Same headers as the corresponding LibreOffice sheet / Excel worksheet:

- `tariff import-catalog`: `code,label,requiresField,fieldLabel,requiresInfo,active,sortOrder,channels`
- `tariff import-prices`: `catalogSlug,venueSlug,zoneKey,tariffCode,priceCents` (or `priceEuro`)`,currency,channels`
- `season send-renew-invites`: `email,renewUrl,firstName,lastName,seats`
- `event import-orders`: `orderId,groupKey,eventSlug`(or `eventId`)`,payerEmail,payerFirstName,payerLastName,zoneKey,seatId,tariffCode,priceCents`(or `priceEuro`)`,quantity,holderFirstName,holderLastName,...` — rows sharing the same `orderId`/`groupKey` become line items of one order; without either, each row becomes its own single-line order (same fallback behaviour as the LibreOffice/Excel macros).

## Job status

`jobs status <job-id>` calls `GET /api/automation/jobs/:id` (requires the `automation:jobs:read` scope on your JWT) to print the job's current status, summary, and log entries — useful since the CLI, unlike the spreadsheet macros, has no popup to show progress after submission.
