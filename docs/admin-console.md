---
title: Admin Console
nav_order: 50
---

# Admin Console

## Entry point

- Base URL: `/admin`
- Auth: bearer token (`ADMIN_TOKEN`) and/or basic auth (`ADMIN_USER` / `ADMIN_PASS`)

## Current scope

- monitoring panels
- CSV exports
- script runner
- automation job launch and follow-up
- partner and subscription monitoring views

The runtime behavior is driven by `src/routes/admin/index.js` and the catalog in `src/config/adminScripts.js`.
