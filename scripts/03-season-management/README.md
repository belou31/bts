# Season Management Scripts

## Core setup
- scripts/03-season-management/create-season.js — create or update a season (code/name/active).
- scripts/03-season-management/instantiate-venue-for-season.js — clone seat and zone catalogs into season collections (`--skip-seats` / `--skip-zones` available).
- scripts/03-season-management/instantiate-tariffs.js — apply one or more tariff catalogs to a season/venue (use `--catalog=<slug>`).
- scripts/03-season-management/import-subscription-orders.js — import subscription orders, book seats, and upsert subscribers.
- scripts/03-season-management/export-subscribers.js — export subscribers for a season/venue.
- scripts/03-season-management/export-subscription-orders.js — export all subscription (phase) orders for review.
- scripts/03-season-management/block-free-seats-for-season.js — block or free season seats from a CSV (seatId, regex, or zoneKey).

## Renewal workflow
- scripts/03-season-management/import-renewers-flat.js — load renewal subscribers from a flat CSV (1 seat per line).
- scripts/03-season-management/renewal-provision-seats.js — mark seats as provisioned for renewal campaigns.
- scripts/03-season-management/export-renew-groups.js — export renewal tokens grouped per subscriber.
- scripts/03-season-management/export-renew-seats.js — export seats involved in the renewal campaign.
- scripts/03-season-management/publish-season.js — open/close the season's activity, renew and subscribe doors.
- scripts/03-season-management/release-unrenewed-seats.js — release seats left provisioned after the renewal window.
