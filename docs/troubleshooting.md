---
title: Troubleshooting
nav_order: 140
---

# Troubleshooting

## First checks

- `node scripts/00-system-management/check-env.js`
- application start logs
- MongoDB connectivity
- payment stub/provider reachability
- admin console access

## Useful maintenance commands

- `npm run db:verify-models`
- `npm run db:sync-indexes`
- `node scripts/sentinels/pending-orders.js`
- reporting and audit scripts from [scripts-catalog.md](scripts-catalog.md)
