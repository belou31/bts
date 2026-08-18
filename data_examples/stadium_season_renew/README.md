# Stadium — new season + renewal test set

Compatible with the `stadium` venue from `data_examples/stadium_map_basic/` +
`data_examples/stadium_tariffs/`. Walks a full season-to-season renewal cycle:
season **2025-2026** has paying subscribers, season **2026-2027** opens and a
renewal campaign (`import-renewers-flat.js`) is run against it, covering six
distinct renewal scenarios (full renewal, family group, partial-family
renewal, seat conflict, standing-zone renewal, and silent churn).

These CSVs were built directly against the current script source
(`scripts/03-season-management/*.js`), not against the checked-in
`data_references/csv/*.template.csv` files — three of those templates
(`renew-subscribers.template.csv`, `subscribers-import.template.csv`, and
`orders-export.template.csv`'s `phase=renewal` value) no longer match what
their corresponding scripts actually parse/require. Worth a fix at some
point, but out of scope here — flagging so the column choices below don't
look arbitrary if you diff them against those templates.

## Files

| File | Feeds | Format |
|---|---|---|
| `season-2025-2026-orders.stadium.csv` | `import-subscription-orders.js` | one row per order line (repeat orderId) |
| `season-2026-2027-priority-order.stadium.csv` | `import-subscription-orders.js` | same format, single conflicting booking |
| `renew-subscribers.stadium.csv` | `import-renewers-flat.js` | **the renewal CSV** — one row per seat |

## Scenarios in `renew-subscribers.stadium.csv`

| Subscriber(s) | 2025-2026 seat(s) | Renews? | What it demonstrates |
|---|---|---|---|
| Nadia Morel | S2-A-01 | ✅ | plain single-seat renewal |
| Karim + Amel Haddad | S1-A-01, S1-A-02 | ✅ both | family group (`HADDAD-FAM`), same `groupKey` → one renewal link for two seats |
| Sophie + Marc Lefevre, **Lucas omitted** | S2-B-01/02/03 | ✅ 2 of 3 | **partial** family renewal — Lucas's `S2-B-03` is simply not in the CSV, so it's never provisioned and opens straight to public sale |
| Yannick Petit | N-A-01 | ✅ (but conflicted) | seat already re-booked by a priority/partner order before provisioning runs → `renewal-provision-seats.js` reports it as `booked_skipped`, not provisioned |
| Yasmine Roy | FAN_ZONE (virtual seat `FAN_ZONE-Z001`) | ✅ | standing-zone renewal: no discrete `Seat` doc exists for it, so provisioning reports it `not_found` by design — standing zones are quota-tracked, not seat-tracked |
| Claire Dubosc | E-A-01 | ❌ not in CSV | **churn** — no row at all; her seat is simply never provisioned and returns to general sale for 2026-2027 |

The `FAN_ZONE-Z001` id isn't arbitrary: `import-subscription-orders.js`
auto-generates virtual seat ids for zone-only lines as
`<ZONE>-Z<lineIndex+1 padded to 3>`. Yasmine's line was `lineIndex=0` in her
order, hence `FAN_ZONE-Z001`. If you add more standing-zone lines, compute
the id the same way (or read it back from an export) before writing the
renewal CSV.

## Walkthrough

Run from the repo root. Add `--commit`/`--apply` only once a dry run looks right.

### 0. Venue catalogs (skip if `stadium` is already registered)

```bash
node scripts/01-venue-management/register-venue.js --venue=stadium --svg=data_examples/stadium_map_basic/stadium.svg
node scripts/01-venue-management/import-zones.js --venue=stadium --csv=data_examples/stadium_map_basic/zones.stadium.csv
node scripts/01-venue-management/import-seats.js --venue=stadium --csv=data_examples/stadium_map_basic/seats.stadium.csv

node scripts/02-tariff-management/import-tariffs.js data_examples/stadium_tariffs/tariff-catalog.stadium.csv
node scripts/02-tariff-management/import-tariff-prices.js stadium-season data_examples/stadium_tariffs/tariff-prices-season.stadium.csv --venue=stadium
```

### 1. Season 2025-2026 — seed the outgoing subscribers

```bash
node scripts/03-season-management/create-season.js 2025-2026 --name="Saison 2025-2026" --venue=stadium
node scripts/03-season-management/instantiate-venue-for-season.js 2025-2026 stadium
node scripts/03-season-management/instantiate-tariffs.js 2025-2026 stadium --catalog=stadium-season

# dry-run first (no --commit)
node scripts/03-season-management/import-subscription-orders.js data_examples/stadium_season_renew/season-2025-2026-orders.stadium.csv --season=2025-2026 --venue=stadium
# then commit
node scripts/03-season-management/import-subscription-orders.js data_examples/stadium_season_renew/season-2025-2026-orders.stadium.csv --season=2025-2026 --venue=stadium --commit
```

This books S2-A-01, S1-A-01/02, S2-B-01/02/03, N-A-01, E-A-01 and the
standing `FAN_ZONE-Z001` line as `paid` for six payers. No `Subscriber`
documents are created at this point — `import-subscription-orders.js`
deliberately doesn't touch that collection (see its final log line).

### 2. Season 2026-2027 — open the new season

```bash
node scripts/03-season-management/create-season.js 2026-2027 --name="Saison 2026-2027" --venue=stadium
node scripts/03-season-management/instantiate-venue-for-season.js 2026-2027 stadium
node scripts/03-season-management/instantiate-tariffs.js 2026-2027 stadium --catalog=stadium-season
node scripts/03-season-management/set-season-phases.js 2026-2027 --phase=renewal --enabled=true
```

### 3. Import the renewal CSV — the actual ask

```bash
node scripts/03-season-management/import-renewers-flat.js data_examples/stadium_season_renew/renew-subscribers.stadium.csv 2026-2027 --venue=stadium
```

Upserts 7 `Subscriber` docs (`status: 'invited'`), one per row — the two
Haddads share `groupKey=HADDAD-FAM`, the two Lefevres share
`groupKey=LEFEVRE-FAM`, everyone else gets their own group.

### 4. Seed the conflict (do this *before* provisioning)

```bash
node scripts/03-season-management/import-subscription-orders.js data_examples/stadium_season_renew/season-2026-2027-priority-order.stadium.csv --season=2026-2027 --venue=stadium --commit
```

Books `N-A-01` for a partner/priority order in 2026-2027 — Yannick's seat
is now `status: 'booked'` before his renewal is ever provisioned.

### 5. Provision renewal seats

```bash
node scripts/03-season-management/renewal-provision-seats.js 2026-2027 --venue=stadium --verbose --apply
```

Expected: `scanned=7 provisioned=5 booked_skipped=1 not_found=1`
- provisioned (5): `S2-A-01`, `S1-A-01`, `S1-A-02`, `S2-B-01`, `S2-B-02`
  (Nadia, both Haddads, both Lefevres who renewed).
- booked_skipped (1): `N-A-01` — already taken by the priority order from step 4.
- not_found (1): `FAN_ZONE-Z001` — no discrete `Seat` doc exists for a virtual/standing seat id.

### 6. (Optional) Generate renewal links / close the campaign

```bash
node scripts/03-season-management/export-renew-groups.js 2026-2027 --venue=stadium --base=https://localhost:8080/bts
node scripts/03-season-management/export-renew-seats.js 2026-2027 --base=https://localhost:8080

# once the renewal window ends, release anything still only 'provisioned'
# (i.e. subscribers who never clicked through to confirm)
node scripts/03-season-management/renewal-close-phase.js 2026-2027 --venue=stadium
```

`renewal-close-phase.js` flips any seat still at `status: 'provisioned'`
back to `available` — in this dataset that's whichever of the 5 provisioned
seats you *don't* separately confirm through the renewal UI/route before
running it, which is the easiest way to see a subscriber who started a
renewal but never finished it.
