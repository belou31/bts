# Season Management Scripts
- scripts/03-season-management/upsert-season.js — create or update a season and its phases.
- scripts/03-season-management/instantiate-venue-for-season.js — clone seat and zone catalogs into season collections (`--skip-seats` / `--skip-zones` available).
- scripts/03-season-management/instantiate-tariffs.js — apply one or more tariff catalogs to a season/venue (use `--catalog=<slug>`).
- scripts/03-season-management/import-subscribers-flat.js — load subscribers from a flat CSV.
- scripts/03-season-management/provision-season-seats.js — apply season provisioning rules to seats.
- scripts/03-season-management/renewal-provision-seats.js — mark seats as provisioned for renewal campaigns.
- scripts/03-season-management/export-renew-groups.js — export renewal tokens grouped per subscriber.
- scripts/03-season-management/export-renew-seats.js — export seats involved in the renewal campaign.
