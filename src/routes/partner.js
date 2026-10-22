// src/routes/partner.js
import { Router } from 'express';
import createEventFlowRouter from './event-flow.factory.js';
import subscriptionRouter from './subscription.js';
import { getPartnerConfig, isInvoicePartner } from '../config/partners.js';
import { Order } from '../models/Order.js';
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

// Identifiant venu de l'IdP du partenaire : échappé avant d'entrer dans le HTML.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function orderToCsvRow(ord) {
  const lines = Array.isArray(ord.lines) ? ord.lines : [];
  return lines.map((ln, idx) => {
    const meta = ln?.meta || {};
    const partnerPrice = ln.partnerPriceCents ?? meta.partnerPriceCents ?? ln.priceCents;
    const displayPrice = ln.priceCents || 0;
    const partnerTotal = ln.partnerTotalCents ?? (displayPrice + partnerPrice);
    const holderFirst = ln.holderFirstName || meta.holderFirstName || '';
    const holderLast = ln.holderLastName || meta.holderLastName || '';
    return [
      ord._id,
      ord.createdAt ? new Date(ord.createdAt).toISOString() : '',
      ord.eventSlug || ord?.meta?.eventSlug || '',
      ord.eventName || ord?.meta?.eventName || '',
      ln.seatId || '',
      ln.zoneKey || '',
      ln.tariffCode || '',
      displayPrice,
      partnerPrice,
      partnerTotal,
      holderFirst,
      holderLast,
      ord.payerFirstName || '',
      ord.payerLastName || '',
      // Identifiant du bénéficiaire connecté (OpenID), cf. partner-entitlements.
      ord?.meta?.partner?.identifier || '',
      ord.payerEmail || ''
    ].join(',');
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
  return `<p>${link('orders?format=html', 'Commandes', 'orders')} · ${link('directory', 'Annuaire', 'directory')}</p>`;
}

// Ancienne adresse : les commandes vivent désormais sous /admin/orders.
adminRouter.get('/:partnerSlug/admin', loadPartnerForAdmin, (req, res) => {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(301, `${req.baseUrl}/${encodeURIComponent(req.partnerConfig.slug)}/admin/orders${qs}`);
});

adminRouter.get('/:partnerSlug/admin/orders', loadPartnerForAdmin, (req, res) => requirePartnerAdmin(req.partnerConfig)(req, res, async () => {
  try {
    const slug = req.partnerConfig.slug;
    const onlyPaid = (req.query.status || '').toLowerCase() === 'paid' || !req.query.status;
    const matchStatus = onlyPaid ? { status: 'paid' } : {};
    const orders = await Order.find({ 'meta.partner.slug': slug, ...matchStatus }).lean();
    const format = (req.query.format || '').toLowerCase();
    if (format === 'csv') {
      const header = ['orderId','createdAt','eventSlug','eventName','seatId','zoneKey','tariffCode','displayPriceCents','partnerPriceCents','partnerTotalCents','holderFirstName','holderLastName','payerFirstName','payerLastName','identifier','payerEmail'].join(',');
      const rows = orders.map(orderToCsvRow).filter(Boolean).join('\n');
      res.setHeader('Content-Type', 'text/csv');
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

    if (format === 'html') {
      const rows = orders.map(o => {
        const meta = o?.meta?.partner || {};
        const lines = Array.isArray(o.lines) ? o.lines : [];
        const lineRows = lines.map(ln => {
          const partnerPrice = ln.partnerPriceCents ?? ln.priceCents;
          const partnerTotal = ln.partnerTotalCents ?? (ln.priceCents + partnerPrice);
          const eventSlug = o.eventSlug || o?.meta?.eventSlug || '';
          const eventName = o.eventName || o?.meta?.eventName || '';
          return `<tr>
            <td>${o._id}</td>
            <td>${o.createdAt ? new Date(o.createdAt).toISOString() : ''}</td>
            <td>${eventSlug}</td>
            <td>${eventName}</td>
            <td>${ln.seatId || ''}</td>
            <td>${ln.zoneKey || ''}</td>
            <td>${ln.tariffCode || ''}</td>
            <td>${ln.priceCents || 0}</td>
            <td>${partnerPrice || 0}</td>
            <td>${partnerTotal || 0}</td>
            <td>${ln.holderFirstName || ''}</td>
            <td>${ln.holderLastName || ''}</td>
            <td>${o.payerFirstName || ''}</td>
            <td>${o.payerLastName || ''}</td>
            <td>${esc(meta.identifier || '')}</td>
            <td>${o.payerEmail || ''}</td>
          </tr>`;
        }).join('');
        return lineRows;
      }).join('');

      res.setHeader('Content-Type', 'text/html');
      res.send(`
        <html><body>
          <h1>Commandes partenaire ${slug}</h1>
          ${adminNav('orders')}
          <p>Commandes: ${summary.count} · Total affiché: ${summary.displayTotal} · Contribution partenaire: ${summary.partnerContribution} · Total partenaire: ${summary.partnerTotal}</p>
          <table border="1" cellspacing="0" cellpadding="4">
            <thead>
              <tr>
                <th>orderId</th><th>createdAt</th><th>eventSlug</th><th>eventName</th><th>seatId</th><th>zoneKey</th><th>tariffCode</th><th>displayPriceCents</th><th>partnerPriceCents</th><th>partnerTotalCents</th><th>holderFirstName</th><th>holderLastName</th><th>payerFirstName</th><th>payerLastName</th><th>identifier</th><th>payerEmail</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </body></html>
      `);
      return;
    }

    res.json({ ok: true, summary, orders });
  } catch (err) {
    console.error('[partner/admin] error:', err);
    res.status(500).json({ ok: false, error: err.message || 'admin_error' });
  }
}));

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
<pre>identifier,lastName,firstName,email,beneficiaries
A123456,DUPONT,Camille,camille.dupont@example.com,4
A123456,DUPONT,Camille,c.dupont@perso.example,4
B987654,MARTIN,Léo,leo.martin@example.com,2</pre>
  <p class="muted">Une ligne par adresse e-mail : un identifiant répété reçoit plusieurs adresses (nom, prénom et nombre de places identiques sur ses lignes). Séparateur <code>,</code> ou <code>;</code>, UTF-8. <code>beneficiaries</code> = nombre de places au titre des droits.</p>
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
