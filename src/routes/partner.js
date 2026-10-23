// src/routes/partner.js
import { Router } from 'express';
import createEventFlowRouter from './event-flow.factory.js';
import subscriptionRouter from './subscription.js';
import { getPartnerConfig, isInvoicePartner } from '../config/partners.js';
import { Order } from '../models/Order.js';
import { Event } from '../models/Event.js';
import { checkPartnerAccess } from '../services/partner-access.js';
import { readSession } from '../services/partner-session.js';
import express from 'express';
import {
  directoryEnabled, parseDirectoryCsv, replaceDirectory, directoryStats, exportDirectoryCsv
} from '../services/partner-directory.js';

const router = Router();
const adminRouter = Router({ mergeParams: true });


const partnerEventRouter = createEventFlowRouter({
  flowKey: 'partner',
  uiPath: '/partner',
  itemNamePrefix: 'PARTNER_EVENT',
  groupKeyPrefix: 'PARTNER',
  mailTemplateKind: 'event',
  originExtras: { channel: 'partner' },
  channelResolver: (req) => ({
    kind: 'partner',
    partnerSlug: String(req.params.partnerSlug || '').trim().toLowerCase(),
    partnerConfig: req.partnerConfig || null,
    session: req.partnerSession || null
  }),
  originResolver: (req, origin) => ({
    ...origin,
    partnerSlug: String(req.params.partnerSlug || '').trim()
  }),
  invoiceReservations: (req) => {
    const cfg = req.partnerConfig;
    if (!cfg || !isInvoicePartner(cfg)) return null;
    return {
      enabled: true,
      status: cfg.reserve?.status || 'pending_invoice',
      paymentProvider: cfg.reserve?.paymentProvider || 'partner_invoice',
      paymentProviderMeta: { partnerSlug: cfg.slug },
      mailTemplateKind: cfg.reserve?.mailTemplateKind || 'event',
      autoFinalize: cfg.reserve?.autoFinalize === true,
      sendTickets: cfg.reserve?.sendTickets !== false
    };
  }
});

// Garde commune aux deux flux partenaire : partenaire connu + jeton valide
// (ou session OIDC, pour un partenaire dont la connexion est obligatoire).
function requireKnownPartner(req, res, next) {
  const cfg = getPartnerConfig(req.params.partnerSlug);
  if (!cfg) {
    if (req.accepts('json')) {
      return res.status(404).json({ ok: false, error: 'partner_not_found' });
    }
    return res.status(404).send('Partner not found');
  }
  const access = checkPartnerAccess(req, cfg, req.params.eventId || req.params.eventSlug);
  if (!access.ok) {
    // 401 et non 403 sans session : la page peut renvoyer se connecter.
    const login = access.reason === 'login_required';
    if (req.accepts('json')) {
      return res.status(login ? 401 : 403)
        .json({ ok: false, error: login ? 'partner_login_required' : 'partner_token_invalid' });
    }
    return res.status(login ? 401 : 403)
      .send(login ? 'Connexion partenaire requise.' : 'Access restricted for this partner (token).');
  }
  req.partnerConfig = cfg;
  // Session OIDC éventuelle (obligatoire ou non) : identité de l'acheteur,
  // base des droits (services/partner-entitlements.js).
  req.partnerSession = access.session || readSession(req, cfg.slug || req.params.partnerSlug);
  next();
}

// Abonnements saison vendus par un partenaire.
//
// C'est le MÊME routeur que /api/season/... : le flux d'abonnement (prix,
// zones, quotas de zone, holds, commande) est identique, seul le canal change.
// Le monter deux fois plutôt que le réécrire évite d'avoir un jour deux
// abonnements qui ne se comportent pas pareil. subscriptionRouter lit
// req.partnerConfig pour savoir qu'il sert un partenaire.
router.use('/:partnerSlug/season/:seasonCode', requireKnownPartner, subscriptionRouter);

router.use('/:partnerSlug/event', requireKnownPartner, partnerEventRouter);

function requirePartnerAdmin(cfg) {
  return (req, res, next) => {
    const user = cfg?.admin?.user;
    const pass = cfg?.admin?.pass;
    if (!user || !pass) {
      return res.status(403).send('Partner admin disabled.');
    }
    const header = req.get('authorization') || '';
    if (!header.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="Partner Admin"');
      return res.status(401).send('Auth required');
    }
    const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString('utf8');
    const [u, p] = decoded.split(':');
    if (u === user && p === pass) return next();
    res.set('WWW-Authenticate', 'Basic realm="Partner Admin"');
    return res.status(401).send('Auth required');
  };
}

const csvCell = (v) => {
  const t = String(v ?? '');
  return /[",;\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

// Une ligne CSV par place. L'événement vient de la commande (eventId), les
// champs eventSlug/eventName n'étant pas stockés sur Order.
function orderToCsvRow(ord, ev) {
  const lines = Array.isArray(ord.lines) ? ord.lines : [];
  return lines.map((ln) => {
    const meta = ln?.meta || {};
    const partnerPrice = ln.partnerPriceCents ?? meta.partnerPriceCents ?? ln.priceCents;
    const displayPrice = ln.priceCents || 0;
    const partnerTotal = ln.partnerTotalCents ?? (displayPrice + partnerPrice);
    return [
      ord._id,
      ord.createdAt ? new Date(ord.createdAt).toISOString() : '',
      ev?.slug || ord.eventSlug || ord?.meta?.eventSlug || '',
      ev?.name || ord.eventName || ord?.meta?.eventName || '',
      ln.seatId || '',
      ln.zoneKey || '',
      ln.tariffCode || '',
      displayPrice,
      partnerPrice,
      partnerTotal,
      ln.holderFirstName || meta.holderFirstName || '',
      ln.holderLastName || meta.holderLastName || '',
      ord.payerFirstName || '',
      ord.payerLastName || '',
      // Identifiant du bénéficiaire connecté (OpenID, annuaire), cf. partner-entitlements.
      ord?.meta?.partner?.identifier || '',
      ord.payerEmail || ''
    ].map(csvCell).join(',');
  }).join('\n');
}

// Pages d'administration du partenaire, sous /partner/<slug>/admin/… :
// orders (commandes) et directory (annuaire local). Même identification
// (bloc `admin` du partenaire) pour toutes.
function loadPartnerForAdmin(req, res, next) {
  const cfg = getPartnerConfig(req.params.partnerSlug);
  if (!cfg) return res.status(404).send('Partner not found');
  req.partnerConfig = cfg;
  next();
}
const partnerAdminAuth = (req, res, next) => requirePartnerAdmin(req.partnerConfig)(req, res, next);

// Liens entre les pages d'administration (relatifs : suivent BASE_PATH).
function adminNav(current) {
  const link = (href, label, key) => (key === current
    ? `<strong>${label}</strong>`
    : `<a href="${href}">${label}</a>`);
  return `<p>${link('orders', 'Commandes', 'orders')} · ${link('directory', 'Annuaire', 'directory')}</p>`;
}

// Ancienne adresse : les commandes vivent désormais sous /admin/orders.
adminRouter.get('/:partnerSlug/admin', loadPartnerForAdmin, (req, res) => {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(301, `${req.baseUrl}/${encodeURIComponent(req.partnerConfig.slug)}/admin/orders${qs}`);
});

const fmtEuro = (cents) => `${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')} €`;
const fmtWhen = (d) => (d ? new Date(d).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }) : '');

// Commandes du partenaire : HTML par défaut (même habillage que
// /control/guestlist), CSV (?format=csv) et JSON (?format=json). Plus récentes
// en tête. Filtres : événement (?event=<slug>) et statut (?status=paid|all,
// payées par défaut) côté serveur ; texte (noms, e-mail, identifiant) dans la
// page, sans rechargement.
adminRouter.get('/:partnerSlug/admin/orders', loadPartnerForAdmin, partnerAdminAuth, async (req, res) => {
  try {
    const cfg = req.partnerConfig;
    const slug = cfg.slug;
    const status = String(req.query.status || 'paid').toLowerCase() === 'all' ? 'all' : 'paid';
    const match = { 'meta.partner.slug': slug, ...(status === 'all' ? {} : { status: 'paid' }) };

    // Événements où le partenaire a des commandes : choix de la liste.
    const eventIds = (await Order.distinct('eventId', match)).filter(Boolean);
    const events = await Event.find({ _id: { $in: eventIds } }, { slug: 1, name: 1, startsAt: 1 })
      .sort({ startsAt: -1 }).lean();
    const eventById = new Map(events.map(e => [String(e._id), e]));
    const selectedSlug = String(req.query.event || '').trim();
    const selected = selectedSlug ? events.find(e => e.slug === selectedSlug) || null : null;
    if (selected) match.eventId = selected._id;

    const orders = await Order.find(match).sort({ createdAt: -1 }).lean();
    const format = String(req.query.format || 'html').toLowerCase();

    if (format === 'csv') {
      const header = ['orderId','createdAt','eventSlug','eventName','seatId','zoneKey','tariffCode','displayPriceCents','partnerPriceCents','partnerTotalCents','holderFirstName','holderLastName','payerFirstName','payerLastName','identifier','payerEmail'].join(',');
      const rows = orders.map(o => orderToCsvRow(o, eventById.get(String(o.eventId)))).filter(Boolean).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="commandes-${slug}${selected ? '-' + selected.slug : ''}.csv"`);
      res.send([header, rows].filter(Boolean).join('\n'));
      return;
    }

    const summary = orders.reduce((acc, o) => {
      const meta = o?.meta?.partner || {};
      acc.displayTotal += meta.displayTotalCents || 0;
      acc.partnerTotal += meta.partnerTotalCents || 0;
      acc.partnerContribution += meta.partnerContributionCents || 0;
      acc.count += 1;
      return acc;
    }, { displayTotal: 0, partnerTotal: 0, partnerContribution: 0, count: 0 });

    if (format === 'json') {
      res.json({ ok: true, summary, orders });
      return;
    }

    // ── HTML ──
    const name = cfg.name || slug;
    const appBase = String(req.baseUrl || '').replace(/\/partner$/, '');
    const logoSrc = `${appBase}/dynamic/assets/logo.png`;
    let places = 0;
    let amount = 0;
    const rowsHtml = orders.map(o => {
      const ev = eventById.get(String(o.eventId));
      const ident = o?.meta?.partner?.identifier || '';
      return (Array.isArray(o.lines) ? o.lines : []).map(ln => {
        places += 1;
        amount += Number(ln.priceCents || 0);
        const holderFirst = ln.holderFirstName || ln?.meta?.holderFirstName || '';
        const holderLast = ln.holderLastName || ln?.meta?.holderLastName || '';
        const search = [holderFirst, holderLast, o.payerFirstName, o.payerLastName, o.payerEmail, ident]
          .map(v => String(v || '').toLowerCase()).join(' ');
        return `<tr data-search="${escHtml(search)}">
          <td>${escHtml(fmtWhen(o.createdAt))}</td>
          <td>${escHtml(ev?.name || '')}</td>
          <td>${escHtml(ln.seatId || ln.zoneKey || '')}</td>
          <td>${escHtml(ln.tariffCode || '')}</td>
          <td class="num">${escHtml(fmtEuro(ln.priceCents))}</td>
          <td>${escHtml(holderLast)}</td>
          <td>${escHtml(holderFirst)}</td>
          <td>${escHtml(o.payerLastName || '')}</td>
          <td>${escHtml(o.payerFirstName || '')}</td>
          <td>${escHtml(ident)}</td>
          <td>${escHtml(o.payerEmail || '')}</td>
          ${status === 'all' ? `<td>${escHtml(o.status || '')}</td>` : ''}
        </tr>`;
      }).join('');
    }).join('');

    const eventOptions = ['<option value="">Tous les événements</option>']
      .concat(events.map(e => `<option value="${escHtml(e.slug)}"${selected && selected.slug === e.slug ? ' selected' : ''}>${escHtml(`${e.name || e.slug} — ${fmtWhen(e.startsAt)}`)}</option>`))
      .join('');
    const csvQuery = new URLSearchParams({ format: 'csv', ...(selected ? { event: selected.slug } : {}), ...(status === 'all' ? { status } : {}) });

    res.type('html').send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Commandes — ${escHtml(name)}</title>
<style>
  :root { color-scheme: dark; font-family: 'Inter', system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #0b0f17; color: #e2e8f0; }
  a { color: inherit; }
  .top-bar { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 18px 28px; background: #0f172a; border-bottom: 1px solid #1e293b; box-shadow: 0 6px 24px rgba(15, 23, 42, 0.55); position: sticky; top: 0; z-index: 20; }
  .brand { display: flex; align-items: center; gap: 16px; }
  .brand img { height: 44px; width: auto; filter: brightness(1.1); }
  .title-block { display: flex; flex-direction: column; }
  .title-block strong { font-size: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b; }
  .title-block span { font-size: 22px; font-weight: 600; color: #f8fafc; }
  .links { display: flex; flex-wrap: wrap; gap: 12px; }
  .pill-link { display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; border-radius: 999px; background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff; text-decoration: none; font-weight: 600; box-shadow: 0 10px 30px rgba(37, 99, 235, 0.4); transition: transform 0.15s ease, box-shadow 0.15s ease; }
  .pill-link.secondary { background: #111c31; border: 1px solid #1e293b; box-shadow: none; color: #cbd5f5; }
  .pill-link:hover { transform: translateY(-1px); }
  main { padding: 0 0 48px; }
  .page { display: grid; gap: 28px; }
  .info-block { padding: 32px 28px 0; }
  h1 { margin: 0; font-size: 28px; font-weight: 700; color: #f8fafc; }
  .muted { margin-top: 8px; color: #94a3b8; font-size: 14px; }
  .stats { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 20px; }
  .stats span { background: #111c31; border: 1px solid #1e293b; border-radius: 12px; padding: 10px 14px; font-size: 14px; display: inline-flex; gap: 8px; align-items: center; color: #cbd5f5; }
  .stats span strong { font-size: 18px; color: #f8fafc; }
  .controls { display: flex; flex-wrap: wrap; gap: 20px; margin-top: 24px; align-items: flex-end; }
  .controls form { display: flex; flex-wrap: wrap; gap: 20px; }
  .controls label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: #cbd5f5; }
  select, input[type="search"] { appearance: none; padding: 10px 14px; font-size: 15px; background: #0f172a; border: 1px solid #1f2a41; border-radius: 10px; color: #f8fafc; min-width: 240px; box-shadow: 0 4px 20px rgba(15, 23, 42, 0.35) inset; }
  select:focus, input[type="search"]:focus { outline: 2px solid rgba(59, 130, 246, 0.4); outline-offset: 0; }
  .table-wrapper { background: #0f172a; border: 1px solid #1f2a41; padding: 12px 0 18px; box-shadow: 0 18px 38px rgba(15, 23, 42, 0.65); overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 960px; font-size: 14px; }
  thead th { position: sticky; top: 0; background: linear-gradient(180deg, rgba(30, 58, 138, 0.45), rgba(15, 23, 42, 0.9)); backdrop-filter: blur(6px); color: #e2e8f0; text-align: left; padding: 12px 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid rgba(148, 163, 184, 0.12); }
  tbody td { padding: 12px 14px; border-bottom: 1px solid rgba(30, 41, 59, 0.7); color: #cbd5f5; white-space: nowrap; }
  tbody tr:nth-child(even) td { background: rgba(15, 23, 42, 0.55); }
  tbody tr:hover td { background: rgba(30, 58, 138, 0.18); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { padding: 24px 28px; color: #94a3b8; }
  @media (max-width: 768px) {
    .top-bar { flex-direction: column; align-items: flex-start; gap: 18px; }
    select, input[type="search"] { min-width: 100%; }
  }
</style>
</head>
<body>
  <header class="top-bar">
    <div class="brand">
      <img src="${escHtml(logoSrc)}" alt="" onerror="this.style.display='none'" />
      <div class="title-block">
        <strong>Espace partenaire</strong>
        <span>${escHtml(name)}</span>
      </div>
    </div>
    <nav class="links">
      <a class="pill-link" href="orders?${escHtml(csvQuery.toString())}">Exporter CSV</a>
      ${directoryEnabled(cfg) ? '<a class="pill-link secondary" href="directory">Annuaire</a>' : ''}
    </nav>
  </header>
  <main>
    <div class="page">
      <section class="info-block">
        <h1>Commandes</h1>
        <p class="muted">${selected ? escHtml(`${selected.name || selected.slug} — ${fmtWhen(selected.startsAt)}`) : 'Tous les événements'} · ${status === 'all' ? 'tous statuts' : 'commandes payées'} · les plus récentes en tête</p>
        <div class="stats">
          <span><strong>${summary.count}</strong> commande(s)</span>
          <span><strong>${places}</strong> place(s)</span>
          <span><strong>${escHtml(fmtEuro(amount))}</strong> au total</span>
        </div>
        <div class="controls">
          <form method="get">
            <label>
              <span>Événement</span>
              <select name="event" onchange="this.form.submit()">${eventOptions}</select>
            </label>
            <label>
              <span>Statut</span>
              <select name="status" onchange="this.form.submit()">
                <option value="paid"${status === 'paid' ? ' selected' : ''}>Payées</option>
                <option value="all"${status === 'all' ? ' selected' : ''}>Toutes</option>
              </select>
            </label>
          </form>
          <label>
            <span>Filtrer noms / email / identifiant</span>
            <input type="search" id="filter" placeholder="Tapez un nom, un email ou un identifiant">
          </label>
        </div>
      </section>
      ${rowsHtml ? `<div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Événement</th><th>Place</th><th>Tarif</th><th class="num">Prix</th>
              <th>Bénéficiaire · Nom</th><th>Bénéficiaire · Prénom</th>
              <th>Contact · Nom</th><th>Contact · Prénom</th><th>Identifiant</th><th>Contact · Email</th>
              ${status === 'all' ? '<th>Statut</th>' : ''}
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>` : '<p class="empty">Aucune commande pour cette sélection.</p>'}
    </div>
  </main>
  <script>
  (function () {
    const input = document.getElementById('filter');
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    if (!input || !rows.length) return;
    input.addEventListener('input', () => {
      const needle = input.value.trim().toLowerCase();
      rows.forEach((row) => {
        row.style.display = !needle || (row.getAttribute('data-search') || '').includes(needle) ? '' : 'none';
      });
    });
  })();
  </script>
</body>
</html>`);
  } catch (err) {
    console.error('[partner/admin] error:', err);
    res.status(500).json({ ok: false, error: err.message || 'admin_error' });
  }
});

// ── Annuaire local (partenaires sans fournisseur d'identité) ───────────────

const fmtDate = (d) => (d ? new Date(d).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : '—');
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

adminRouter.get('/:partnerSlug/admin/directory', loadPartnerForAdmin, partnerAdminAuth, async (req, res) => {
  try {
    const cfg = req.partnerConfig;
    const stats = await directoryStats(cfg.slug);
    const enabled = directoryEnabled(cfg);
    res.type('html').send(`<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Annuaire — ${escHtml(cfg.name || cfg.slug)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1d2733}
.card{border:1px solid #dde3ea;border-radius:10px;padding:1rem 1.2rem;margin:1rem 0}
.muted{color:#667;font-size:.9rem}.warn{color:#b45309}.err{color:#b91c1c}.ok{color:#047857}
code,pre{background:#eef2f6;border-radius:4px;padding:0 .25rem}pre{padding:.6rem;overflow:auto}
table{border-collapse:collapse}td,th{border:1px solid #dde3ea;padding:.25rem .5rem;font-size:.9rem;text-align:left}
</style>
<h1>Annuaire — ${escHtml(cfg.name || cfg.slug)}</h1>
${adminNav('directory')}
<div class="card">
  <p>Connexion par annuaire : ${enabled
    ? '<strong class="ok">activée</strong> — les ayants droit se connectent avec leur identifiant et une adresse e-mail de cette liste.'
    : '<strong class="warn">non activée</strong> — l\'annuaire peut être préparé ; la connexion s\'active depuis la console d\'administration (Set Partner Directory).'}</p>
  <p>${stats.members} ayant(s) droit · ${stats.emails} adresse(s) e-mail · dernier import : ${escHtml(fmtDate(stats.lastImport))}</p>
  <p><a href="directory.csv">Télécharger l'annuaire actuel (CSV)</a></p>
</div>
<div class="card">
  <h2 style="font-size:1rem;margin-top:0">Importer un annuaire</h2>
  <p>L'import <strong>remplace</strong> l'annuaire entier. Il est refusé en bloc si une ligne est invalide : rien n'est modifié tant que le fichier n'est pas entièrement correct.</p>
  <p><input type="file" id="csv" accept=".csv,text/csv,text/plain"> <button id="send" type="button">Importer</button></p>
  <div id="report" aria-live="polite"></div>
  <details><summary>Format attendu</summary>
<pre>identifier,lastName,firstName,email,beneficiaries,extraPublic
A123456,DUPONT,Camille,camille.dupont@example.com,4,2
A123456,DUPONT,Camille,c.dupont@perso.example,4,2
B987654,MARTIN,Léo,leo.martin@example.com,2,</pre>
  <p class="muted">Une ligne par adresse e-mail : un identifiant répété reçoit plusieurs adresses (nom, prénom et nombres identiques sur ses lignes). Séparateur <code>,</code> ou <code>;</code>, UTF-8. <code>beneficiaries</code> = nombre de places au titre des droits. <code>extraPublic</code> (colonne facultative) = places en plus au tarif public pour cet ayant droit ; vide = la valeur par défaut du partenaire.</p>
  </details>
</div>
<script>
const report = document.getElementById('report');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
document.getElementById('send').addEventListener('click', async () => {
  const file = document.getElementById('csv').files[0];
  if (!file) { report.innerHTML = '<p class="err">Choisissez un fichier CSV.</p>'; return; }
  report.innerHTML = '<p class="muted">Import en cours…</p>';
  const res = await fetch('directory', { method: 'POST', headers: { 'Content-Type': 'text/csv; charset=utf-8' }, body: await file.text() });
  const r = await res.json().catch(() => ({ ok: false, message: 'Réponse illisible' }));
  if (r.ok) {
    report.innerHTML = '<p class="ok">' + esc(r.imported) + ' ayant(s) droit importé(s), ' + esc(r.removed) + ' retiré(s).</p>';
    setTimeout(() => location.reload(), 1500);
    return;
  }
  const rows = (r.errors || []).map(e => '<tr><td>' + esc(e.line) + '</td><td>' + esc(e.identifier || '') + '</td><td>' + esc(e.reason) + '</td></tr>').join('');
  report.innerHTML = '<p class="err">' + esc(r.message || 'Import refusé') + '</p>'
    + (rows ? '<table><tr><th>Ligne</th><th>Identifiant</th><th>Motif</th></tr>' + rows + '</table>' : '');
});
</script>
</html>`);
  } catch (err) {
    console.error('[partner/admin/directory] error:', err);
    res.status(500).send('Erreur de chargement de l\'annuaire');
  }
});

adminRouter.post('/:partnerSlug/admin/directory', loadPartnerForAdmin, partnerAdminAuth,
  express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }),
  async (req, res) => {
    try {
      const { members, errors } = parseDirectoryCsv(typeof req.body === 'string' ? req.body : '');
      if (errors.length) {
        return res.status(400).json({ ok: false, message: `Import refusé : ${errors.length} problème(s), annuaire inchangé.`, errors });
      }
      if (!members.length) {
        return res.status(400).json({ ok: false, message: 'Aucune ligne valide : import refusé (il viderait l\'annuaire).', errors: [] });
      }
      const result = await replaceDirectory(req.partnerConfig.slug, members);
      console.log(`[partner/admin/directory] ${req.partnerConfig.slug} : ${result.imported} importé(s), ${result.removed} retiré(s)`);
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[partner/admin/directory] import error:', err);
      return res.status(500).json({ ok: false, message: 'Erreur pendant l\'import : annuaire peut-être partiellement mis à jour, relancez l\'import.' });
    }
  });

adminRouter.get('/:partnerSlug/admin/directory.csv', loadPartnerForAdmin, partnerAdminAuth, async (req, res) => {
  try {
    const csv = await exportDirectoryCsv(req.partnerConfig.slug);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="annuaire-${req.partnerConfig.slug}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[partner/admin/directory.csv] error:', err);
    res.status(500).send('Export impossible');
  }
});

export { adminRouter };
export default router;
