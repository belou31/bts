# Stadium — ticket advertising showcase

Compatible with the `stadium` venue from `data_examples/stadium_map_basic/` +
`data_examples/stadium_tariffs/` (same fixtures the `stadium_season_renew`
example uses). Walks the full ad-campaign lifecycle for one event —
**Ad Campaigns Demo Match** — with four sponsors covering every mechanism
the system supports: a wildcard fallback sponsor, a zone-targeted sponsor,
a tariff-targeted sponsor with a multi-asset carousel and a text coupon, and
a zone-targeted sponsor with its own untracked QR code. It ends by seeding
real paid orders so you can generate actual ticket PDFs and see the
resolution engine pick a different sponsor per ticket.

## Files

| File | Feeds | Format |
|---|---|---|
| `club-partner-logo.svg`, `north-bank-banner.svg`, `fanzone-energy-banner.svg` | `import-ad-campaign-asset.js` | one asset each |
| `family-snacks-banner-v1.svg`, `family-snacks-banner-v2.svg` | `import-ad-campaign-asset.js` (zipped together first) | a 2-image carousel for one campaign |
| `ticket-ads.svg` | `import-templates.js` | the ad-aware ticket template (`adPict`/`adQr`/`{{AD_TEXT}}` slots) this catalog targets — local copy of `data_references/templates/tickets/ticket-ads.svg` |
| `ad-campaign-catalog.stadium.csv` | `import-ad-campaign-catalog.js` | WHERE/WHEN each campaign shows — see `data_references/csv/ad-campaign-catalog.template.csv` for the column contract |
| `event-orders.stadium.csv` | `import-orders.js` | **the payoff** — one row per ticket line, `eventId` left blank on purpose (see step 6) |

## Scenarios in `ad-campaign-catalog.stadium.csv`

| Campaign | Placement scope | contentType(s) | What it demonstrates |
|---|---|---|---|
| `club-partner` | wildcard (no filter), `priority=10` | image + qr | The fallback every other campaign competes against — a ticket with no more specific sponsor still gets a logo and a **trackable** QR (no `qrValue` set, so it's built from `targetUrl` at render time) |
| `north-bank` | `zoneKey=N`, `priority=100` | image | Zone-specific sponsor — a `zoneKey` match outscores `club-partner`'s wildcard for the `adPict` slot in Stand North, on *any* tariff |
| `family-snacks` | `tariffCode=CHILD`, `priority=100` | image (carousel of 2) + text | Tariff-specific sponsor; its asset is a `.zip` of two banners, so consecutive CHILD tickets in the *same order* alternate between them; also fills the `AD_TEXT` slot with a coupon line |
| `fanzone-energy` | `zoneKey=FAN_ZONE`, `priority=100` | image + qr | Standing-zone sponsor with its **own raw `qrValue`** (`ENERGY-FREECAN-2026`) — printed as-is, no `/promo/` tracking redirect |

The interesting edge case is Stand North + CHILD: `north-bank` (zoneKey)
outscores `family-snacks` (tariffCode) for the `adPict` **image** slot — but
`AD_TEXT` is a separate slot nobody else targets, so `family-snacks`'s
coupon text still shows even though its banner doesn't. Each slot resolves
independently; see `resolvePlacementsForTicket` in `src/services/tickets-pdf.js`.

## Walkthrough

Run from the repo root.

### 0. Venue + tariffs (skip if `stadium` is already registered)

```bash
node scripts/01-venue-management/register-venue.js --venue=stadium --svg=data_examples/stadium_map_basic/stadium.svg
node scripts/01-venue-management/import-zones.js --venue=stadium --csv=data_examples/stadium_map_basic/zones.stadium.csv
node scripts/01-venue-management/import-seats.js --venue=stadium --csv=data_examples/stadium_map_basic/seats.stadium.csv

node scripts/02-tariff-management/import-tariffs.js data_examples/stadium_tariffs/tariff-catalog.stadium.csv
node scripts/02-tariff-management/import-tariff-prices.js stadium-season data_examples/stadium_tariffs/tariff-prices-season.stadium.csv --venue=stadium
node scripts/02-tariff-management/import-tariff-prices.js stadium-event data_examples/stadium_tariffs/tariff-prices-event.stadium.csv --venue=stadium
```

### 1. Season + event

```bash
node scripts/03-season-management/create-season.js 2026-2027 --name="Saison 2026-2027" --venue=stadium
node scripts/03-season-management/instantiate-venue-for-season.js 2026-2027 stadium
node scripts/03-season-management/instantiate-tariffs.js 2026-2027 stadium --catalog=stadium-season

node scripts/04-event-management/create.js --slug=stadium-ad-demo --name="Ad Campaigns Demo Match" --date=2026-11-01T18:00:00+01:00 --season=2026-2027
# create.js has no --venue flag; the event needs one before it can instantiate
# seats/zones, so pass it here — this also persists venueSlug on the event.
node scripts/04-event-management/instantiate-venue-for-event.js --event=stadium-ad-demo --venue=stadium
node scripts/04-event-management/instantiate-tariffs.js --event=stadium-ad-demo --catalog=stadium-event
```

### 2. Define the sponsor campaigns (assets + identity)

```bash
node scripts/02-ticket-ad-management/import-ad-campaign-asset.js --file=data_examples/stadium_ad_campaigns/club-partner-logo.svg --slug=club-partner-logo --campaign=club-partner
node scripts/02-ticket-ad-management/set-ad-campaign.js --slug=club-partner --target-url=https://club-partner.example/offer --label="Club Partner"

node scripts/02-ticket-ad-management/import-ad-campaign-asset.js --file=data_examples/stadium_ad_campaigns/north-bank-banner.svg --slug=north-bank-banner --campaign=north-bank
node scripts/02-ticket-ad-management/set-ad-campaign.js --slug=north-bank --label="North Bank"

# family-snacks: two banners as one carousel — zip them first
zip -j /tmp/family-snacks.zip data_examples/stadium_ad_campaigns/family-snacks-banner-v1.svg data_examples/stadium_ad_campaigns/family-snacks-banner-v2.svg
node scripts/02-ticket-ad-management/import-ad-campaign-asset.js --file=/tmp/family-snacks.zip --slug=family-snacks-carousel --campaign=family-snacks
node scripts/02-ticket-ad-management/set-ad-campaign.js --slug=family-snacks --label="Family Snacks Co"

node scripts/02-ticket-ad-management/import-ad-campaign-asset.js --file=data_examples/stadium_ad_campaigns/fanzone-energy-banner.svg --slug=fanzone-energy-banner --campaign=fanzone-energy
node scripts/02-ticket-ad-management/set-ad-campaign.js --slug=fanzone-energy --label="FanZone Energy"
```

### 3. Import the placement catalog and instantiate it for the event

```bash
node scripts/02-ticket-ad-management/import-ad-campaign-catalog.js stadium-ad-demo data_examples/stadium_ad_campaigns/ad-campaign-catalog.stadium.csv
node scripts/04-event-management/instantiate-ad-campaigns.js --event=stadium-ad-demo --catalog=stadium-ad-demo
```

### 4. Adopt the ad-aware ticket template

```bash
node scripts/00-system-management/import-templates.js --resource=ticket --file=data_examples/stadium_ad_campaigns/ticket-ads.svg --kind=event
```

`ticket-ads.svg` already has the `adPict`/`adQr` slots and the `{{AD_TEXT}}`
token this catalog targets — see its own header comment for the contract.
Templates are cached in-process; restart the server for this to take effect
(`node scripts/00-system-management/pm2-control.js --name=bts --action=restart`).

### 5. Seed paid orders — the payoff

```bash
node scripts/04-event-management/import-orders.js data_examples/stadium_ad_campaigns/event-orders.stadium.csv --event=stadium-ad-demo --status=paid --commit
```

`eventId`/`eventSlug` are blank in the CSV on purpose — `--event=stadium-ad-demo`
resolves it for every row, so this file has no environment-specific ID baked in.

Five orders, six tickets:

| Payer | Seat | Zone/tariff | `adPict` shows | `adQr` shows | `AD_TEXT` shows |
|---|---|---|---|---|---|
| Julien Petit | S1-A-01 | S1 / NORMAL | Club Partner logo | Club Partner (trackable) | — |
| Chloe Bernard | N-A-01 | N / NORMAL | North Bank banner | Club Partner (trackable) | — |
| Emma Rousseau | N-A-02 | N / CHILD | North Bank banner | Club Partner (trackable) | Family Snacks coupon |
| Lucas Girard | S2-A-01 | S2 / CHILD | Family Snacks **v1** | Club Partner (trackable) | Family Snacks coupon |
| Mia Girard (same order) | S2-A-02 | S2 / CHILD | Family Snacks **v2** | Club Partner (trackable) | Family Snacks coupon |
| Manon Faure | FAN_ZONE (standing) | FAN_ZONE / NORMAL | FanZone Energy banner | FanZone raw QR (untracked) | — |

### 6. Generate a ticket PDF to see it

```bash
node scripts/04-event-management/events/tickets-pdf.js --event=stadium-ad-demo --id=<orderId> --out=data/outputs/demo-ticket.pdf
```

Find an `orderId` via `node scripts/04-event-management/export-tickets.js --event=stadium-ad-demo`.
Open the PDF for Lucas/Mia Girard's order to see both carousel variants
across their two ticket pages.

### 7. Tear down (optional)

```bash
node scripts/02-ticket-ad-management/remove-ad-campaign-catalog.js --catalog=stadium-ad-demo --force
node scripts/04-event-management/remove-event-ad-campaigns.js --event=stadium-ad-demo --force
node scripts/02-ticket-ad-management/remove-ad-campaign.js --slug=club-partner --force
node scripts/02-ticket-ad-management/remove-ad-campaign.js --slug=north-bank --force
node scripts/02-ticket-ad-management/remove-ad-campaign.js --slug=family-snacks --force
node scripts/02-ticket-ad-management/remove-ad-campaign.js --slug=fanzone-energy --force
# --allow-paid-orders: step 5 seeded paid orders for this event
node scripts/04-event-management/delete-event.js --event=stadium-ad-demo --allow-paid-orders --force
node scripts/03-season-management/remove-season-tariffs.js --season=2026-2027 --venue=stadium --allow-active-season --force
```

`remove-ad-campaign.js` also deletes the campaign's staged asset file(s)
(and the carousel folder, once empty) — no manual cleanup under
`data/assets/ads/` needed. `delete-event.js` takes the orders/tickets and
event-scoped tariffs with it; the season/venue/tariff-catalog fixtures are
left in place since `stadium_season_renew` (and re-runs of this example)
reuse them.
