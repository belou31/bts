// src/routes/admin.js
import express from 'express';
import os from 'node:os';
import childProcess from 'node:child_process';
import mongoose from 'mongoose';
import { Order } from '../models/Order.js';
import { Seat }  from '../models/Seat.js';
import { Zone }  from '../models/Zone.js';
import { exportOrdersCsv, exportSeatsCsv } from '../services/exports.js';

const router = express.Router();

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
router.get('/', async (_req, res) => {
  const mongoState = mongoose.connection?.readyState; // 0=disconnected 1=connected 2=connecting 3=disconnecting
  const mongoStateLabel = ['disconnected','connected','connecting','disconnecting'][mongoState || 0];

  // PM2 (best-effort)
  let pm2 = null;
  try {
    const out = childProcess.execSync('pm2 jlist', { encoding:'utf8', stdio:['ignore','pipe','ignore'] });
    pm2 = JSON.parse(out).map(p => ({
      name: p.name, pid: p.pid, status: p.pm2_env?.status,
      uptime: p.pm2_env?.pm_uptime ? new Date(p.pm2_env.pm_uptime).toISOString() : null,
      restarts: p.pm2_env?.restart_time ?? 0,
      mem: p.monit?.memory ?? 0, cpu: p.monit?.cpu ?? 0
    }));
  } catch { /* ignore */ }

  // Compteurs basiques seats
  const byStatus = await Seat.aggregate([
    { $group: { _id: '$status', c: { $sum: 1 } } }
  ]);
  const seatCounts = Object.fromEntries(byStatus.map(x => [x._id || 'unknown', x.c]));

  // Compteurs orders récents
  const since = new Date(Date.now() - 24*60*60*1000);
  const recentOrders = await Order.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: '$status', c: { $sum: 1 } } }
  ]);

  res.set('Content-Type','text/html; charset=utf-8');
  res.send(`<!doctype html><meta charset="utf-8">
  <title>BTS — Admin</title>
  <style>
    body{font:14px/1.5 system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:24px;background:#fafafa;color:#222}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
    .card{background:#fff;border:1px solid #eee;border-radius:12px;padding:16px}
    h1{font-size:18px;margin:0 0 16px}
    h2{font-size:16px;margin:0 0 8px}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #eee;padding:6px 8px;text-align:left}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#eee}
    .ok{color:#0b7d2b}.warn{color:#b36b00}.bad{color:#b3001e}
    a.btn{display:inline-block;margin-top:8px;padding:6px 10px;border:1px solid #ddd;border-radius:8px;text-decoration:none;color:#222;background:#fff}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  </style>
  <h1>BTS — Administration</h1>
  <div class="grid">
    <div class="card">
      <h2>Serveur</h2>
      <div>Host: <span class="mono">${os.hostname()}</span></div>
      <div>Node: ${process.version}</div>
      <div>Env: <span class="pill">${process.env.APP_ENV || 'unknown'}</span></div>
      <div>Base path: <span class="mono">${process.env.BASE_PATH || '/'}</span></div>
      <div>MongoDB: <strong>${mongoStateLabel}</strong></div>
    </div>

    <div class="card">
      <h2>PM2</h2>
      ${pm2 ? `
      <table>
        <tr><th>name</th><th>pid</th><th>status</th><th>cpu</th><th>mem</th><th>restarts</th></tr>
        ${pm2.map(p=>`<tr>
          <td>${p.name}</td><td>${p.pid||''}</td>
          <td>${p.status}</td><td>${p.cpu||0}%</td><td>${(p.mem/1048576).toFixed(0)} MB</td><td>${p.restarts}</td>
        </tr>`).join('')}
      </table>` : `<div class="warn">PM2 non disponible (jlist)</div>`}
    </div>

    <div class="card">
      <h2>Sièges (état global)</h2>
      <table>
        <tr><th>status</th><th>count</th></tr>
        ${Object.entries(seatCounts).map(([k,v])=>`<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
      </table>
    </div>

    <div class="card">
      <h2>Commandes (24h)</h2>
      <table>
        <tr><th>status</th><th>count</th></tr>
        ${recentOrders.map(x=>`<tr><td>${x._id||'unknown'}</td><td>${x.c}</td></tr>`).join('')}
      </table>
    </div>

    <div class="card">
      <h2>Exports</h2>
      <div><a class="btn" href="./export/orders.csv">Exporter les commandes (CSV)</a></div>
      <div><a class="btn" href="./export/seats.csv">Exporter les sièges (CSV)</a></div>
      <div><a class="btn" href="./stats/zones">Statistiques zones (HTML)</a></div>
      <div><a class="btn" href="./stats/zones.json">Statistiques zones (JSON)</a></div>
    </div>
  </div>`);
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

async function computeZoneUsageAllOrders({ seasonCode, venueSlug, zoneKeys }) {
  const rows = await Order.aggregate([
    { $match: {
      seasonCode, venueSlug,
      status: { $nin: ['canceled', 'failed'] },
      'lines.zoneKey': { $in: zoneKeys }
    }},
    { $unwind: '$lines' },
    { $match: { 'lines.zoneKey': { $in: zoneKeys } } },
    { $group: { _id: '$lines.zoneKey', count: { $sum: 1 } } }
  ]);
  return new Map(rows.map(r => [String(r._id), Number(r.count || 0)]));
}

async function zonesSnapshot() {
  const activeSeason = await Order.findOne({}).sort({ createdAt: -1 }).lean();
  const seasonCode = activeSeason?.seasonCode || process.env.SEASON_CODE || null;
  const venueSlug  = activeSeason?.venueSlug  || process.env.VENUE_SLUG  || null;

  const [zones, usage] = await Promise.all([
    Zone.find({ seasonCode, venueSlug, key: { $in: SUB_ZONE_KEYS }, isActive: true }).lean(),
    computeZoneUsageAllOrders({ seasonCode, venueSlug, zoneKeys: SUB_ZONE_KEYS })
  ]);

  const out = zones.map(z => {
    const quota     = Number(z.quota || 0);
    const capacity  = Number(z.capacity || 0);
    const plafond   = quota > 0 ? quota : capacity;
    const used      = usage.get(z.key) || 0;
    const remaining = Math.max(0, (plafond || 0) - used);
    return {
      key: z.key, name: z.name || z.key, quota, capacity, used, remaining
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
  </style>
  <h1>Stats zones — <span class="mono">${snap.seasonCode || ''} / ${snap.venueSlug || ''}</span></h1>
  <div class="grid">
    <div>
      <h2>TBH7 & zones publiques</h2>
      <table>
        <tr><th>zone</th><th>quota</th><th>capacity</th><th>utilisés</th><th>restants</th></tr>
        ${snap.subZones.map(z=>`<tr>
          <td>${z.key}</td><td>${z.quota}</td><td>${z.capacity}</td><td>${z.used}</td><td>${z.remaining}</td>
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
