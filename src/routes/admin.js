// src/routes/admin.js
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import mongoose from 'mongoose';
import { Order } from '../models/Order.js';
import { Seat }  from '../models/Seat.js';
import { Zone }  from '../models/Zone.js';
import { exportOrdersCsv, exportSeatsCsv } from '../services/exports.js';
import { adminScriptGroups, getAdminScript } from '../config/adminScripts.js';

const router = express.Router();

const ROOT_DIR = process.cwd();
const TEMPLATES_ROOT = path.resolve(ROOT_DIR, 'data/templates');
const OUTPUTS_ROOT = path.resolve(ROOT_DIR, 'data/outputs');
const INPUTS_ROOT = path.resolve(ROOT_DIR, 'data/inputs');
for (const dir of [OUTPUTS_ROOT, INPUTS_ROOT]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

/* ===================== Base path & helpers URLs ===================== */
const BASE_PATH = process.env.BASE_PATH || '';
const trimEndSlash = (s='') => s.replace(/\/+$/,'');
const urlJoin = (base='', p='') => `${trimEndSlash(base)}${p.startsWith('/') ? p : `/${p}`}`;
const urlFor = (p='') => urlJoin(BASE_PATH, p); // ex: urlFor('/admin/export/orders.csv')

function parseArgLine(line = '') {
  const args = [];
  let current = '';
  let quote = null;
  let escape = false;

  for (const char of String(line || '')) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

async function runAdminScript(script, userArgs = []) {
  if (!script?.run?.script) throw new Error('Script is not runnable');
  const resolvedScript = path.resolve(process.cwd(), script.run.script);
  const baseArgs = Array.isArray(script.run.args) ? script.run.args.filter(Boolean) : [];
  const extraArgs = Array.isArray(userArgs) ? userArgs.filter(arg => arg != null && arg !== '') : [];
  const spawnArgs = [resolvedScript, ...baseArgs, ...extraArgs];

  return await new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, spawnArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function sanitizeFilename(name = '') {
  const trimmed = String(name || '').trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || null;
}

function resolveInside(root, candidate) {
  const normalizedCandidate = String(candidate || '').replace(/^\/+/, '');
  const target = path.resolve(root, normalizedCandidate);
  const resolvedRoot = path.resolve(root);
  if (!target.startsWith(resolvedRoot + path.sep) && target !== resolvedRoot) {
    throw new Error('Forbidden path');
  }
  return target;
}

function listFiles(root, limit = 50) {
  try {
    return fs.readdirSync(root)
      .map(name => {
        const full = path.join(root, name);
        let stats;
        try { stats = fs.statSync(full); } catch { return null; }
        if (!stats.isFile()) return null;
        return { name, rel: name, size: stats.size, mtime: stats.mtime };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/* ===================== Sécurité =====================

  Deux modes possibles (cumulables) :
  1) Bearer token :   ADMIN_TOKEN="xxxxx"
     - Header:       Authorization: Bearer xxxxx
     - OU query:     ?token=xxxxx

  2) Basic Auth  :    ADMIN_USER="user", ADMIN_PASS="pass"
     - Header:       Authorization: Basic base64(user:pass)

  Si rien n'est défini → accès refusé.
*/
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_USER  = process.env.ADMIN_USER  || '';
const ADMIN_PASS  = process.env.ADMIN_PASS  || '';

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Basic realm="BTS Admin"');
  return res.status(401).send('Unauthorized');
}

function adminAuth(req, res, next) {
  // Bearer / query token
  const queryTok = (req.query.token || '').toString();
  const hdr      = (req.headers.authorization || '').toString();
  const bearer   = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';

  if (ADMIN_TOKEN && (queryTok === ADMIN_TOKEN || bearer === ADMIN_TOKEN)) return next();

  // Basic
  if (ADMIN_USER && ADMIN_PASS && hdr.startsWith('Basic ')) {
    try {
      const dec = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
      const [u,p] = dec.split(':',2);
      if (u === ADMIN_USER && p === ADMIN_PASS) return next();
    } catch {}
  }

  return unauthorized(res);
}

router.use(adminAuth);

/* ===================== Utilitaires ===================== */
const csvEscape = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
};
const isVirtualZoneSeatId = sid => /^.+-Z\d{3,}$/i.test(String(sid||''));

/* ===================== Page HTML ===================== */
router.get('/', async (req, res) => {
  // Redirige /admin → /admin/ en conservant la query-string (pour ?token=...)
  const [pathOnly, qs=''] = (req.originalUrl || '').split('?', 2);
  if (pathOnly && !pathOnly.endsWith('/')) {
    return res.redirect(302, `${pathOnly}/${qs ? `?${qs}` : ''}`);
  }

  const mongoState = mongoose.connection?.readyState; // 0=disconnected 1=connected 2=connecting 3=disconnecting
  const mongoStateLabel = ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoState || 0];

  // PM2 (best-effort)
  let pm2 = null;
  try {
    const out = childProcess.execSync('pm2 jlist', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    pm2 = JSON.parse(out).map(p => ({
      name: p.name,
      pid: p.pid,
      status: p.pm2_env?.status,
      uptime: p.pm2_env?.pm_uptime ? new Date(p.pm2_env.pm_uptime).toISOString() : null,
      restarts: p.pm2_env?.restart_time ?? 0,
      mem: p.monit?.memory ?? 0,
      cpu: p.monit?.cpu ?? 0
    }));
  } catch { /* ignore */ }

  // Compteurs basiques seats
  const byStatus = await Seat.aggregate([
    { $group: { _id: '$status', c: { $sum: 1 } } }
  ]);
  const seatCounts = Object.fromEntries(byStatus.map(x => [x._id || 'unknown', x.c]));

  // Compteurs orders récents
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentOrders = await Order.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: '$status', c: { $sum: 1 } } }
  ]);

  // Si la page a été ouverte avec ?token=..., on le propage dans les liens
  const token = (req.query.token || '').toString();
  const tokenQuery = token ? `token=${encodeURIComponent(token)}` : '';
  const tokenSuffix = token ? `?${tokenQuery}` : '';

  const sortedScriptGroups = adminScriptGroups
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(group => ({
      ...group,
      scripts: group.scripts
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    }));

  const activeGroupId = typeof req.query.group === 'string' && req.query.group
    ? req.query.group
    : (sortedScriptGroups[0]?.id || null);

  const outputsList = listFiles(OUTPUTS_ROOT);
  const inputsList = listFiles(INPUTS_ROOT);

  return res.render('admin/index', {
    basePath: BASE_PATH || '',
    token,
    tokenQuery,
    tokenSuffix,
    urlFor,
    serverInfo: {
      host: os.hostname(),
      nodeVersion: process.version,
      env: process.env.APP_ENV || 'unknown',
      basePath: process.env.BASE_PATH || '/',
      mongoState: mongoStateLabel
    },
    pm2,
    seatCounts,
    recentOrders,
    scriptGroups: sortedScriptGroups,
    activeGroupId,
    outputsList,
    inputsList
  });
});

/* ===================== Script runner ===================== */
router.post('/scripts/:scriptId/run', async (req, res) => {
  const scriptId = (req.params.scriptId || '').toString();
  const found = getAdminScript(scriptId);
  if (!found?.script) {
    return res.status(404).json({ error: 'Unknown script' });
  }

  if (!found.script.run?.script) {
    return res.status(400).json({ error: 'Script cannot be run automatically' });
  }

  const body = req.body || {};
  const arrayArgs = Array.isArray(body.args) ? body.args.filter(Boolean) : [];
  const lineArgs = typeof body.argLine === 'string' ? parseArgLine(body.argLine) : [];
  const extraArgs = [...arrayArgs, ...lineArgs];

  if (found.script.danger) {
    const confirmToken = typeof body.confirm === 'string' ? body.confirm.trim() : '';
    if (confirmToken !== found.script.id) {
      return res.status(400).json({
        error: 'Confirmation required',
        confirmToken: found.script.id
      });
    }
  }

  try {
    const result = await runAdminScript(found.script, extraArgs);
    return res.json({
      ok: result.code === 0,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

router.get('/templates/download', (req, res) => {
  const rawPath = (req.query.path || '').toString();
  if (!rawPath) return res.status(400).send('Missing template path');
  try {
    const relative = rawPath.replace(/^(?:scripts|data)\/templates\/?/, '');
    const abs = resolveInside(TEMPLATES_ROOT, relative);
    const filename = path.basename(abs);
    return res.download(abs, filename);
  } catch {
    return res.status(400).send('Invalid template path');
  }
});

router.get('/outputs/download', (req, res) => {
  const raw = (req.query.file || '').toString();
  if (!raw) return res.status(400).send('Missing file');
  try {
    const abs = resolveInside(OUTPUTS_ROOT, raw);
    return res.download(abs, path.basename(abs));
  } catch {
    return res.status(400).send('Invalid output file');
  }
});

router.get('/inputs/download', (req, res) => {
  const raw = (req.query.file || '').toString();
  if (!raw) return res.status(400).send('Missing file');
  try {
    const abs = resolveInside(INPUTS_ROOT, raw);
    return res.download(abs, path.basename(abs));
  } catch {
    return res.status(400).send('Invalid input file');
  }
});

router.post('/uploads', (req, res) => {
  const { filename, contentBase64 } = req.body || {};
  const safeName = sanitizeFilename(filename || '');
  if (!safeName) return res.status(400).json({ ok: false, error: 'Invalid target file name' });
  if (!contentBase64 || typeof contentBase64 !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing contentBase64' });
  }
  let buffer;
  try {
    buffer = Buffer.from(contentBase64, 'base64');
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid base64 payload' });
  }
  const dest = path.join(INPUTS_ROOT, safeName);
  try {
    fs.writeFileSync(dest, buffer);
    return res.json({ ok: true, filename: safeName, path: `data/inputs/${safeName}`, size: buffer.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'Unable to store file' });
  }
});


/* ===================== Export commandes (CSV) ===================== */
router.get('/export/orders.csv', async (req, res) => {
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="orders.csv"');
  const filter = {};
  if (req.query.season) filter.seasonCode = String(req.query.season);
  if (req.query.venue)  filter.venueSlug  = String(req.query.venue);
  if (req.query.status) filter.status     = String(req.query.status);
  await exportOrdersCsv({ out: res, filter, includeHeader: true });
  res.end();
});

/* ===================== Export sièges (CSV enrichi) ===================== */
router.get('/export/seats.csv', async (req, res) => {
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="seats.csv"');
  const filterSeat  = {};
  const filterOrder = {};
  if (req.query.season) { filterSeat.seasonCode = String(req.query.season); filterOrder.seasonCode = String(req.query.season); }
  if (req.query.venue)  { filterSeat.venueSlug  = String(req.query.venue);  filterOrder.venueSlug  = String(req.query.venue); }
  if (req.query.zone)   { filterSeat.zoneKey    = String(req.query.zone); }
  await exportSeatsCsv({ out: res, filterSeat, filterOrder, includeHeader: true });
  res.end();
});


/* ===================== Stats zones (HTML/JSON) =====================

  - Vue claire pour TBH7 / TBH7-VIRAGE / DEBOUT : quota, capacity, utilisés, restants (via Orders).
  - Vue complémentaire par statut Seat (available / provisioned / booked) pour toutes zones siège.
*/
const SUB_ZONE_KEYS = ['TBH7', 'TBH7-VIRAGE', 'DEBOUT'];

async function computeZoneUsageAllOrders({ seasonCode, venueSlug, zoneKeys, statusIn = null }) {
  // Si statusIn est défini → filtre inclusif (ex: ['paid'])
  // Sinon → fallback historique (tout sauf canceled/failed)
  const statusMatch = Array.isArray(statusIn) && statusIn.length
    ? { status: { $in: statusIn } }
    : { status: { $nin: ['canceled', 'failed'] } };

  const rows = await Order.aggregate([
    { $match: { seasonCode, venueSlug, ...statusMatch, 'lines.zoneKey': { $in: zoneKeys } } },
    { $unwind: '$lines' },
    { $match: { 'lines.zoneKey': { $in: zoneKeys } } },
    { $group: { _id: '$lines.zoneKey', count: { $sum: 1 } } }
  ]);
  return new Map(rows.map(r => [String(r._id || ''), Number(r.count || 0)]));
}

async function zonesSnapshot() {
  const activeSeason = await Order.findOne({}).sort({ createdAt: -1 }).lean();
  const seasonCode = activeSeason?.seasonCode || process.env.SEASON_CODE || null;
  const venueSlug  = activeSeason?.venueSlug  || process.env.VENUE_SLUG  || null;

  // usagePaid = seulement "paid" (référence pour quota subscription)
  // usageAll  = tout sauf canceled/failed (diagnostic)
  const [zones, usagePaid, usageAll] = await Promise.all([
    Zone.find({ seasonCode, venueSlug, key: { $in: SUB_ZONE_KEYS }, isActive: true }).lean(),
    computeZoneUsageAllOrders({ seasonCode, venueSlug, zoneKeys: SUB_ZONE_KEYS, statusIn: ['paid'] }),
    computeZoneUsageAllOrders({ seasonCode, venueSlug, zoneKeys: SUB_ZONE_KEYS })
  ]);

  const out = zones.map(z => {
    const quota     = Number(z.quota || 0);
    const capacity  = Number(z.capacity || 0);
    const plafond   = quota > 0 ? quota : capacity;
    const usedPaid  = usagePaid.get(z.key) || 0;
    const usedAll   = usageAll.get(z.key)  || 0;
    const pending   = Math.max(0, usedAll - usedPaid); // indicatif
    const remainingPaid = Math.max(0, (plafond || 0) - usedPaid);
    return {
      key: z.key,
      name: z.name || z.key,
      quota,
      capacity,
      usedPaid,
      usedAll,
      pending,
      remainingPaid
    };
  });

  // Par statut (pour toutes zones sièges)
  const byZoneStatus = await Seat.aggregate([
    { $group: { _id: { zoneKey:'$zoneKey', status:'$status' }, c: { $sum: 1 } } }
  ]);
  const zoneMatrix = {};
  for (const r of byZoneStatus) {
    const z = r._id.zoneKey || '';
    const st = r._id.status || 'unknown';
    (zoneMatrix[z] || (zoneMatrix[z] = {}))[st] = r.c;
  }

  return { seasonCode, venueSlug, subZones: out, seatStatuses: zoneMatrix };
}

router.get('/stats/zones.json', async (_req, res) => {
  const snap = await zonesSnapshot();
  res.json(snap);
});

router.get('/stats/zones', async (_req, res) => {
  const snap = await zonesSnapshot();
  res.set('Content-Type','text/html; charset=utf-8');
  res.send(`<!doctype html><meta charset="utf-8">
  <title>BTS — Zones</title>
  <style>
    body{font:14px/1.5 system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:24px}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #eee;padding:6px 8px;text-align:left}
    h1{font-size:18px;margin:0 0 12px}
    .grid{display:grid;grid-template-columns:1fr;gap:24px}
    .mono{font-family:ui-monospace,Consolas,monospace}
    .muted{color:#666}  </style>
  <h1>Stats zones — <span class="mono">${snap.seasonCode || ''} / ${snap.venueSlug || ''}</span></h1>
  <div class="grid">
    <div>
      <h2>TBH7 & zones publiques</h2>
      <p class="muted">Le quota *subscription* s’appuie sur <strong>usedPaid</strong> (commandes payées). La colonne <em>pending</em> est informative (= usedAll − usedPaid).</p>
      <table>
        <tr>
          <th>zone</th>
          <th>quota</th>
          <th>capacity</th>
          <th>usedPaid</th>
          <th>usedAll</th>
          <th>pending</th>
          <th>remaining (paid)</th>
        </tr>
        ${snap.subZones.map(z=>`<tr>
          <td>${z.key}</td>
          <td>${z.quota}</td>
          <td>${z.capacity}</td>
          <td>${z.usedPaid}</td>
          <td>${z.usedAll}</td>
          <td>${z.pending}</td>
          <td>${z.remainingPaid}</td>
        </tr>`).join('')}
      </table>
    </div>
    <div>
      <h2>Par statut de siège (toutes zones à places numérotées)</h2>
      <table>
        <tr><th>zoneKey</th><th>available</th><th>provisioned</th><th>booked</th><th>busy</th><th>autre</th></tr>
        ${Object.entries(snap.seatStatuses).map(([zone,stats])=>{
          const other = Object.entries(stats).filter(([k])=>!['available','provisioned','booked','busy'].includes(k))
                         .map(([k,v])=>`${k}:${v}`).join(' ');
          return `<tr>
            <td>${zone}</td>
            <td>${stats.available||0}</td>
            <td>${stats.provisioned||0}</td>
            <td>${stats.booked||0}</td>
            <td>${stats.busy||0}</td>
            <td>${other||''}</td>
          </tr>`;
        }).join('')}
      </table>
    </div>
  </div>`);
});

export default router;
