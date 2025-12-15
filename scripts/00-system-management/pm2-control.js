#!/usr/bin/env node
/**
 * Control PM2-managed services (start/restart).
 *
 * Usage:
 *   node scripts/00-system-management/pm2-control.js --name=bts [--action=restart|start]
 *
 * - If action is "restart", a missing process will trigger a fallback "start".
 * - Allowed names: bts, bts-sentinel, bts-logrotate.
 */
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const getOpt = (key) => {
  const prefix = `--${key}=`;
  const direct = args.find((a) => a.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const i = args.indexOf(`--${key}`);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return undefined;
};

const name = getOpt('name');
const actionRaw = getOpt('action') || 'restart';
const action = ['restart', 'start'].includes(actionRaw) ? actionRaw : 'restart';
const allowed = new Set(['bts', 'bts-sentinel', 'bts-logrotate']);

if (!name || !allowed.has(name)) {
  console.error(`Usage: node pm2-control.js --name=<${Array.from(allowed).join('|')}> [--action=restart|start]`);
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  if (action === 'restart') {
    try {
      const out = run(`pm2 restart ${name}`);
      console.log(out || `Restarted ${name}`);
      process.exit(0);
    } catch (err) {
      console.warn(`[pm2-control] restart failed, attempting start for ${name}: ${err.message}`);
      const out = run(`pm2 start ${name}`);
      console.log(out || `Started ${name}`);
    }
  } else {
    const out = run(`pm2 start ${name}`);
    console.log(out || `Started ${name}`);
  }
} catch (err) {
  console.error(`[pm2-control] ${action} ${name} failed:`, err.message || err);
  process.exit(1);
}
