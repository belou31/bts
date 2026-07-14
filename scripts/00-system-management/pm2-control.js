#!/usr/bin/env node
/**
 * Control PM2-managed services (start/restart).
 *
 * Usage:
 *   node scripts/00-system-management/pm2-control.js --name=bts [--action=restart|start]
 *
 * - If action is "restart", a missing process will trigger a fallback "start" (when a script or command is known).
 * - Allowed names: bts, bts-sentinel, bts-logrotate, pm2-logrotate.
 * - bts / bts-sentinel are started from ../../ecosystem.config.cjs (repo-versioned flags),
 *   not ad-hoc `pm2 start <script>` — see that file for the canonical `--cron`/`--no-autorestart` setup.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

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
// bts and bts-sentinel are defined in ecosystem.config.cjs (checked into git) so their
// start flags (notably bts-sentinel's --cron/--no-autorestart) are versioned instead of
// living only in whichever host last ran `pm2 save`.
const START_TARGETS = {
  bts: { cmd: 'pm2 start ecosystem.config.cjs --only bts', name: 'bts' },
  'bts-sentinel': { cmd: 'pm2 start ecosystem.config.cjs --only bts-sentinel', name: 'bts-sentinel' },
  'bts-logrotate': { module: 'pm2-logrotate' },
  'pm2-logrotate': { module: 'pm2-logrotate' }
};
const allowed = new Set(Object.keys(START_TARGETS));

if (!name || !allowed.has(name)) {
  console.error(`Usage: node pm2-control.js --name=<${Array.from(allowed).join('|')}> [--action=restart|start]`);
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const resolveModuleScript = (moduleName) => {
  const pm2Home = process.env.PM2_HOME || path.join(process.env.HOME || '', '.pm2');
  const candidate = path.join(pm2Home, 'modules', moduleName, 'node_modules', moduleName, 'app.js');
  if (candidate && fs.existsSync(candidate)) return candidate;
  return null;
};

const startProcess = () => {
  const target = START_TARGETS[name];
  if (!target) {
    throw new Error(`No start command mapped for "${name}" (define it in pm2-control.js).`);
  }
  if (target.cmd) {
    const out = run(target.cmd);
    console.log(out || `Started via: ${target.cmd}`);
    return;
  }
  if (target.module) {
    const scriptPath = resolveModuleScript(target.module);
    if (scriptPath) {
      const out = run(`pm2 start ${scriptPath} --name ${target.module}`);
      console.log(out || `Started ${target.module} (${scriptPath})`);
      return;
    }
    const out = run(`pm2 start ${target.module}`);
    console.log(out || `Started ${target.module}`);
    return;
  }
  const scriptPath = target.script;
  const procName = target.name || name;
  const out = run(`pm2 start ${scriptPath} --name ${procName}`);
  console.log(out || `Started ${procName} (${scriptPath})`);
};

try {
  if (action === 'restart') {
    try {
      const out = run(`pm2 restart ${name}`);
      console.log(out || `Restarted ${name}`);
      process.exit(0);
    } catch (err) {
      console.warn(`[pm2-control] restart failed, attempting start for ${name}: ${err.message}`);
      startProcess();
    }
  } else {
    startProcess();
  }
} catch (err) {
  console.error(`[pm2-control] ${action} ${name} failed:`, err.message || err);
  process.exit(1);
}
