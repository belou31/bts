// src/routes/admin.js
import express from 'express';
import { exec } from 'node:child_process';
import util from 'node:util';
import mongoose from 'mongoose';
import { Order, Seat } from '../models/index.js';

const router = express.Router();
const asyncExec = util.promisify(exec);

/* ========== Helpers ========== */
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function nowSlug() {
  const d = new Date();
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function mapReadyState(n) {
  return ({0:'disconnected',1:'connected',2:'connecting',3:'disconnecting'})[Number(n)] || String(n);
}

async function getPm2List() {
  // Minimaliste: on tente "pm2 jlist" si dispo (aucune dépendance)
  try {
    const { stdout } = await asyncExec('pm2 jlist');
    const arr = JSON.parse(stdout);
    return arr.map(p => ({
      name: p.name,
      pm_id: p.pm_id,
      status: p.pm2_env?.status,
      restart: p.pm2_env?.restart_time,
      uptimeSec: Math.max(0, Math.floor(((Date.now()/1000) - (p.pm2_env?.pm_uptime/1000)) || 0)),
      cpu: p.monit?.cpu,
      mem: p.monit?.memory
    }));
  } catch {
    // fallback ultra simple avec ce process seulement
    return [{
      name: process.env.name || process.title || 'bts',
      pm_id: process.env.pm_id || null,
      status: 'unknown',
      restart: null,
      uptimeSec: Math.round(process.uptime()),
      cpu: null,
      mem: null
    }];
  }
}

/* ========== PAGE ========== */
router.get('/admin', (_req, res) => {
  // HTML ultra simple + assets génériques
  res.type('html').send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Admin — BTS</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="static/img/favicon.ico">
<link rel="stylesheet" href="static/styles/generic-view.css">
<style>
  body { background:#0f172a; color:#e2e8f0; }
  .wrap { max-width:1100px; margin:24px auto; padding:0 16px; }
  h1 { margin:0 0 16px; font-size:24px; }
  .grid { display:grid; gap:16px; grid-template-columns: repeat(auto-fit,minmax(280px,1fr)); }
  .card { background:#111827; border:1px solid #1f2937; border-radius:12px; padding:16px; }
  .card h2 { margin:0 0 8px; font-size:18px; color:#93c5fd; }
  .kv { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:13px; line-height:1.5; }
  .kv div { display:flex; justify-content:space-between; gap:8px; border-bottom:1px dashed #1f2937; padding:4px 0; }
  .kv div span:first-child { color:#9ca3af; }
  a.btn { display:inline-block; background:#1f2937; border:1px solid #374151; color:#e5e7eb; padding:8px 12px; border-radius:8px; text-decoration:none; }
  a.btn:hover { background:#111827; }
  .pm2-table, .mongo-table { width:100%; border-collapse:collapse; font-size:13px; }
  .pm2-table th, .pm2-table td, .mongo-table th, .mongo-table td { border-bottom:1px solid #1f2937; padding:6px 8px; text-align:left; }
  .ok { color:#34d399; } .warn { color:#f59e0b; } .err { color:#f87171; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Admin — BTS (MVP)</h1>

  <div class="grid">
    <div class="card">
      <h2>Application</h2>
      <div class="kv" id="appBox"></div>
      <p><a class="btn" href="#" id="refreshBtn">Rafraîchir</a></p>
    </div>

    <div class="card">
      <h2>MongoDB</h2>
      <table class="mongo-table" id="mongoTable"></table>
    </div>

    <div class="card">
      <h2>PM2</h2>
      <table class="pm2-table" id="pm2Table"></table>
    </div>

    <div class="card">
      <h2>Exports CSV</h2>
      <p><a class="btn" href="api/admin/export/orders.csv">Télécharger commandes</a></p>
      <p><a class="btn" href="api/admin/export/seats.csv">Télécharger sièges</a></p>
    </div>
  </div>
</div>

<script>
async function load() {
  const r = await fetch('api/admin/status', { headers:{Accept:'application/json'} });
  const s = await r.json();

  const app = document.getElementById('appBox');
  app.innerHTML = '';
  const addKV = (k,v) => { const d=document.createElement('div'); d.innerHTML = '<span>'+k+'</span><span>'+v+'</span>'; app.appendChild(d); };
  addKV('ENV', s.app.env);
  addKV('BASE_PATH', s.app.basePath || '(none)');
  addKV('PID', s.app.pid);
  addKV('Uptime', s.app.uptimeSec+'s');
  addKV('Node', s.app.node);

  const mt = document.getElementById('mongoTable');
  mt.innerHTML = '<tr><th>Paramètre</th><th>Valeur</th></tr>'+
    '<tr><td>State</td><td>' + s.mongo.state + '</td></tr>'+
    '<tr><td>DB</td><td>' + (s.mongo.db||'') + '</td></tr>'+
    '<tr><td>Orders</td><td>' + s.counts.orders + '</td></tr>'+
    '<tr><td>Seats (total)</td><td>' + s.counts.seats.total + '</td></tr>'+
    '<tr><td>Seats (booked)</td><td>' + s.counts.seats.booked + '</td></tr>'+
    '<tr><td>Seats (busy)</td><td>' + s.counts.seats.busy + '</td></tr>'+
    '<tr><td>Seats (available)</td><td>' + s.counts.seats.available + '</td></tr>';

  const pt = document.getElementById('pm2Table');
  pt.innerHTML = '<tr><th>Name</th><th>pm_id</th><th>Status</th><th>Uptime</th><th>CPU</th><th>Mem</th></tr>' +
    s.pm2.map(p => '<tr>'+
      '<td>'+ (p.name||'') +'</td>'+
      '<td>'+ (p.pm_id??'') +'</td>'+
      '<td>'+ (p.status||'') +'</td>'+
      '<td>'+ (p.uptimeSec||0) +'s</td>'+
      '<td>'+ (p.cpu??'') +'</td>'+
      '<td>'+ (p.mem??'') +'</td>'+
    '</tr>').join('');
}
document.getElementById('refreshBtn').addEventListener('click', (e)=>{ e.preventDefault(); load(); });
load();
</script>
</body>
</html>`);
});

/* ========== API ========== */

// GET /api/admin/status
router.get('/api/admin/status', async (_req, res) => {
  try {
    const pm2 = await getPm2List();

    const conn = mongoose.connection;
    const state = mapReadyState(conn?.readyState);
    const dbName = conn?.name || conn?.db?.databaseName || '';

    const orders = await Order.countDocuments({});
    const seatAgg = await Seat.aggregate([
      { $group: { _id: '$status', n: { $sum: 1 } } }
    ]);
    const seats = { total: 0, booked: 0, busy: 0, available: 0, other: 0 };
    for (const r of seatAgg) {
      const k = String(r._id||'').toLowerCase();
      const n = Number(r.n||0);
      seats.total += n;
      if (k === 'booked' || k === 'sold') seats.booked += n;
      else if (k === 'busy' || k === 'provisioned' || k === 'blocked') seats.busy += n;
      else if (k === 'available') seats.available += n;
      else seats.other += n;
    }

    res.json({
      app: {
        env: process.env.APP_ENV || process.env.NODE_ENV || 'development',
        basePath: process.env.BASE_PATH || '',
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        node: process.version
      },
      mongo: { state, db: dbName },
      counts: { orders, seats },
      pm2
    });
  } catch (e) {
    console.error('[admin status] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/admin/export/orders.csv  (une ligne par *ligne* de commande)
router.get('/api/admin/export/orders.csv', async (req, res) => {
  try {
    const { seasonCode, venueSlug } = req.query;
    const q = {};
    if (seasonCode) q.seasonCode = String(seasonCode);
    if (venueSlug)  q.venueSlug  = String(venueSlug);

    const cursor = Order.find(q).lean().cursor();

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${nowSlug()}.csv"`);

    const header = [
      'orderId','createdAt','phase','status',
      'payerFirstName','payerLastName','payerEmail',
      'seasonCode','venueSlug','paymentSplit',
      'totalCents',
      'lineIndex','seatId','zoneKey','tariffCode','priceCents',
      'holderFirstName','holderLastName'
    ].join(',');
    res.write(header + '\n');

    let idx=0;
    for await (const o of cursor) {
      const base = [
        o._id, o.createdAt?.toISOString?.() || '', o.phase||'', o.status||'',
        o.payerFirstName||'', o.payerLastName||'', o.payerEmail||'',
        o.seasonCode||'', o.venueSlug||'', o.paymentSplit||'',
        o.totalCents||0
      ].map(csvEscape).join(',');

      const lines = Array.isArray(o.lines) ? o.lines : [];
      if (!lines.length) {
        res.write(base + ',,,,\n'); // ligne vide si pas de détails
        continue;
      }
      let j=0;
      for (const l of lines) {
        const row = [
          base,
          j,
          l.seatId||'',
          l.zoneKey||'',
          l.tariffCode||'',
          l.priceCents||0,
          l.holderFirstName||'',
          l.holderLastName||''
        ].map(csvEscape).join(',');
        res.write(row + '\n');
        j++; idx++;
      }
    }
    res.end();
  } catch (e) {
    console.error('[admin export orders] error:', e);
    res.status(500).send('internal_error');
  }
});

// GET /api/admin/export/seats.csv  (état courant des sièges)
router.get('/api/admin/export/seats.csv', async (req, res) => {
  try {
    const { seasonCode, venueSlug } = req.query;
    const q = {};
    if (seasonCode) q.seasonCode = String(seasonCode);
    if (venueSlug)  q.venueSlug  = String(venueSlug);

    const cursor = Seat.find(q, { _id:0 }).lean().cursor();

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="seats-${nowSlug()}.csv"`);

    res.write(['seasonCode','venueSlug','seatId','zoneKey','status'].join(',') + '\n');

    for await (const s of cursor) {
      const row = [
        s.seasonCode||'',
        s.venueSlug||'',
        s.seatId||'',
        s.zoneKey||'',
        s.status||''
      ].map(csvEscape).join(',');
      res.write(row + '\n');
    }
    res.end();
  } catch (e) {
    console.error('[admin export seats] error:', e);
    res.status(500).send('internal_error');
  }
});

export default router;
