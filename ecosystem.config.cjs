// pm2 process definitions for BTS — the source of truth for how `bts` and
// `bts-sentinel` are started on INT/PROD (`pm2 save` only snapshots whatever
// is currently running on a given host; it does not version-control the
// start flags, so this file exists to keep them out of shell history).
//
// Usage:
//   pm2 start ecosystem.config.cjs                # start every app
//   pm2 start ecosystem.config.cjs --only bts-sentinel
//   pm2 save                                       # persist for `pm2 resurrect` / `pm2 startup`

module.exports = {
  apps: [
    {
      name: 'bts',
      script: 'src/server.js',
      interpreter: 'node',
      autorestart: true
    },
    {
      name: 'bts-sentinel',
      script: 'scripts/sentinels/pending-orders.js',
      interpreter: 'node',
      autorestart: false,
      cron_restart: '*/2 * * * *'
    }
  ]
};
