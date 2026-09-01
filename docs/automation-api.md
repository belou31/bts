---
title: Automation API
nav_order: 70
---

# Automation API

> Generated from code.
> Source: src/routes/automation/index.js, src/services/automation/tasks/*, src/middlewares/automation-auth.js
> Regenerate with: `npm run docs:refs`

## Entry point

- Base path: `/api/automation`

## Authentication model

- JWT secret: `AUTOMATION_JWT_SECRET`
- Optional issuer check: `AUTOMATION_JWT_ISSUER`
- Optional audience check: `AUTOMATION_JWT_AUDIENCE`
- Optional IP allowlist: `AUTOMATION_ALLOWED_IPS`
- Accepted token sources: `Authorization: Bearer ...`, `x-automation-token`, or query `token`

## HTTP surfaces

- `GET /scripts` lists available tasks.
- `GET /scripts/:id` reads one task definition.
- `POST /scripts/:id/jobs` creates a job and optionally runs it synchronously.
- `GET /jobs` lists jobs.
- `GET /jobs/:jobId` reads one job.
- `GET /jobs/:jobId/logs` reads serialized logs.

## Registered tasks

| Task ID | Summary | Scopes | Dry-run | Parameters |
| --- | --- | --- | --- | --- |
| `event.import-orders` | Importe des commandes d'évènement depuis un CSV (data/inputs) ou un payload JSON et les insère dans MongoDB. | `automation:jobs:write`, `automation:jobs:run`, `automation:events:write` | yes | `csv`, `orders`, `force`, `sendEmail`, `status`, `event`, `eventId`, `eventSlug` |
| `season.send-renew-invites` | Envoie les invitations de renouvellement par e-mail à partir d’un CSV exporté. | `automation:jobs:write`, `automation:jobs:run`, `automation:renewals:write` | yes | `csv`, `subject`, `limit`, `offset`, `delayMs`, `separator`, `template`, `seasonCode`, `clubName`, `deadline`, `venue`, `fromName`, `providerLabel`, `invitees` |
| `tariff.export-catalog` | Exporte le catalogue de tarifs (code/label/...) au format JSON. | `automation:jobs:write`, `automation:jobs:run` | yes | — |
| `tariff.export-zone-tariffs` | Exporte les prix par zone ou méta-zone (zoneKey/metaZone/tariffCode/prix) pour une saison et un lieu donnés. | `automation:jobs:write`, `automation:jobs:run` | yes | `seasonCode`, `venueSlug` |
| `tariff.import-catalog` | Importe le catalogue de tarifs (code/label...) depuis un tableur ou JSON. | `automation:jobs:write`, `automation:jobs:run` | yes | `entries` |
| `tariff.import-prices` | Importe un catalogue de prix (zone / tarif / prix). | `automation:jobs:write`, `automation:jobs:run`, `automation:events:write` | yes | `catalogSlug`, `venueSlug`, `append`, `entries` |

## event.import-orders

- Version: `1.0.0`
- Summary: Importe des commandes d'évènement depuis un CSV (data/inputs) ou un payload JSON et les insère dans MongoDB.
- Dry-run: supported
- Scopes: `automation:jobs:write`, `automation:jobs:run`, `automation:events:write`
- Tags: `event`, `orders`, `import`
- Parameters: `csv`, `orders`, `force`, `sendEmail`, `status`, `event`, `eventId`, `eventSlug`

## season.send-renew-invites

- Version: `1.0.0`
- Summary: Envoie les invitations de renouvellement par e-mail à partir d’un CSV exporté.
- Dry-run: supported
- Scopes: `automation:jobs:write`, `automation:jobs:run`, `automation:renewals:write`
- Tags: `renewal`, `email`, `season`
- Parameters: `csv`, `subject`, `limit`, `offset`, `delayMs`, `separator`, `template`, `seasonCode`, `clubName`, `deadline`, `venue`, `fromName`, `providerLabel`, `invitees`

## tariff.export-catalog

- Version: `1.0.0`
- Summary: Exporte le catalogue de tarifs (code/label/...) au format JSON.
- Dry-run: supported
- Scopes: `automation:jobs:write`, `automation:jobs:run`
- Tags: `tariff`, `catalog`
- Parameters: —

## tariff.export-zone-tariffs

- Version: `1.0.0`
- Summary: Exporte les prix par zone ou méta-zone (zoneKey/metaZone/tariffCode/prix) pour une saison et un lieu donnés.
- Dry-run: supported
- Scopes: `automation:jobs:write`, `automation:jobs:run`
- Tags: `tariff`, `zone`, `prices`
- Parameters: `seasonCode`, `venueSlug`

## tariff.import-catalog

- Version: `1.0.0`
- Summary: Importe le catalogue de tarifs (code/label...) depuis un tableur ou JSON.
- Dry-run: supported
- Scopes: `automation:jobs:write`, `automation:jobs:run`
- Tags: `tariff`, `catalog`
- Parameters: `entries`

## tariff.import-prices

- Version: `1.0.0`
- Summary: Importe un catalogue de prix (zone / tarif / prix).
- Dry-run: supported
- Scopes: `automation:jobs:write`, `automation:jobs:run`, `automation:events:write`
- Tags: `tariff`, `catalog`
- Parameters: `catalogSlug`, `venueSlug`, `append`, `entries`

