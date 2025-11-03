# Venue Management Scripts
- scripts/01-venue-management/register-venue.js — register or update a venue and optionally copy an SVG plan (use `--overwrite` to replace).
- scripts/01-venue-management/import-seats.js — parse the persisted SVG plan (`data-seat-id`) and upsert seat catalog records, with optional CSV overrides.
- scripts/01-venue-management/import-zones.js — maintain the venue zone catalog from CSV and/or SVG (`data-zone-id` by default).
- scripts/01-venue-management/validate-svg.js — sanity-check selectors and seat counts inside an SVG plan.
