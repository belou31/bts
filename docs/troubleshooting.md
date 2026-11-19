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

## 502 Bad Gateway (Nginx) after a deploy

Nginx error log shows `connect() failed (111: Connection refused) while connecting to upstream` — the app isn't listening on its port at all (not a crash-loop, not a port mismatch: nothing is there).

```bash
pm2 status
pm2 logs bts --lines 100 --nostream
```

If the logs show `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '...'`, a dependency added to `package.json` since the last deploy was never installed on this host. Fix:

```bash
cd ~/bts
npm install
node scripts/00-system-management/pm2-control.js --name=bts --action=restart
```

See [installation.md § Mettre à jour un déploiement existant](installation.md#mettre-à-jour-un-déploiement-existant-int--prod) for the full update sequence (`git pull` → `npm install` → restart, in that order, every time) — skipping `npm install` after a `git pull` is the most common cause of this.

## Useful maintenance commands

- `npm run db:verify-models`
- `npm run db:sync-indexes`
- `node scripts/sentinels/pending-orders.js`
- reporting and audit scripts from [scripts-catalog.md](scripts-catalog.md)
