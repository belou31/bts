// src/routes/control/guestlist.js
import { Router } from 'express';
import mongoose, { isValidObjectId } from 'mongoose';
import { Event } from '../../models/Event.js';
import { Order } from '../../models/Order.js';
import { Ticket } from '../../models/Ticket.js';
import { ScanLog } from '../../models/ScanLog.js';
import requireScanner from '../../middlewares/require-scanner.js';

const router = Router();

const { ObjectId } = mongoose.Types;

function basePath() {
  return process.env.BASE_PATH || '';
}

function withBasePath(pathname = '') {
  return `${basePath()}${pathname}`.replace(/\/{2,}/g, '/');
}

async function loadEventByIdOrSlug(eventIdOrSlug) {
  const raw = String(eventIdOrSlug || '').trim();
  if (!raw) throw new Error('Event not found');

  if (isValidObjectId(raw)) {
    const byId = await Event.findById(new ObjectId(raw)).lean();
    if (byId) return byId;
  }

  const bySlug = await Event.findOne({ slug: raw }).lean();
  if (!bySlug) throw new Error('Event not found');
  return bySlug;
}

function splitSeat(seatId) {
  const seat = String(seatId || '').trim();
  const match = /^([A-Z0-9]+)-([A-Z])-([0-9]{1,4})$/i.exec(seat);
  if (!match) {
    return {
      section: '',
      row: '',
      seatNo: '',
      label: seat
    };
  }
  return {
    section: match[1].toUpperCase(),
    row: match[2].toUpperCase(),
    seatNo: match[3],
    label: `${match[1].toUpperCase()}-${match[2].toUpperCase()}-${match[3]}`
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(dateLike) {
  if (!dateLike) return '';
  try {
    const date = new Date(dateLike);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('fr-FR');
  } catch {
    return '';
  }
}

function buildCredentialParams(source) {
  const params = new URLSearchParams();
  const token = String(source.token || '').trim();
  const login = String(source.login || '').trim();
  const password = String(source.password || '').trim();
  if (token) params.set('token', token);
  if (login) params.set('login', login);
  if (password) params.set('password', password);
  return params;
}

const FEEDBACK_MESSAGES = {
  'enter-ok': { text: 'Ticket marqué comme entré.', kind: 'ok' },
  'enter-fail': { text: 'Impossible de marquer le ticket comme entré.', kind: 'err' },
  'exit-ok': { text: 'Ticket marqué comme sorti.', kind: 'ok' },
  'exit-fail': { text: 'Impossible de marquer le ticket comme sorti.', kind: 'err' }
};

function safeFeedback(code) {
  return FEEDBACK_MESSAGES[code] || null;
}

function summarizeTickets(tickets) {
  let scanned = 0;
  let exits = 0;
  for (const t of tickets) {
    if (t.scannedAt) scanned += 1;
    else if ((t.scanHistory || []).some((entry) => entry?.action === 'exit')) exits += 1;
  }
  return { total: tickets.length, scanned, exits };
}

router.get('/control/event/:eventIdOrSlug/guestlist', (req, res) => {
  const key = String(req.params.eventIdOrSlug || '').trim();
  const params = buildCredentialParams(req.query);
  if (key) params.set('event', key);
  const qs = params.toString();
  const target = withBasePath(`/control/guestlist${qs ? `?${qs}` : ''}`);
  res.redirect(302, target);
});

router.get('/admin/event/:eventIdOrSlug/guestlist', (req, res) => {
  const key = String(req.params.eventIdOrSlug || '').trim();
  const params = buildCredentialParams(req.query);
  if (key) params.set('event', key);
  const qs = params.toString();
  const target = withBasePath(`/control/guestlist${qs ? `?${qs}` : ''}`);
  res.redirect(302, target);
});

router.get('/admin/guestlist', (req, res) => {
  const params = buildCredentialParams(req.query);
  const qs = params.toString();
  const target = withBasePath(`/control/guestlist${qs ? `?${qs}` : ''}`);
  res.redirect(302, target);
});

router.get('/control/guestlist', requireScanner, async (req, res) => {
  try {
    const credentialParams = buildCredentialParams({
      token: req.scannerAuth?.token || req.query.token,
      login: req.scannerAuth?.login || req.query.login,
      password: req.query.password
    });

    const events = await Event.find({}, { name: 1, slug: 1, startsAt: 1 })
      .sort({ startsAt: 1 })
      .lean();

    if (!events.length) {
      res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>Liste des invités — Aucun évènement</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 16px; }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { color: #555; }
</style>
<h1>Liste des invités</h1>
<p>Aucun évènement disponible.</p>`);
      return;
    }

    let selectedEventKey = String(req.query.event || '').trim();
    if (!selectedEventKey) {
      const first = events[0];
      selectedEventKey = String(first.slug || first._id);
    }

    let eventDoc;
    try {
      eventDoc = await loadEventByIdOrSlug(selectedEventKey);
    } catch {
      const fallback = events[0];
      selectedEventKey = String(fallback.slug || fallback._id);
      eventDoc = await loadEventByIdOrSlug(selectedEventKey);
    }

    const eventIdString = String(eventDoc._id);
    const ticketDocs = await Ticket.find({ eventId: eventIdString }).lean();

    const orderIds = [];
    for (const ticket of ticketDocs) {
      const id = ticket?.orderId;
      if (id && ObjectId.isValid(id) && !orderIds.some((existing) => existing.equals?.(id))) {
        orderIds.push(id instanceof ObjectId ? id : new ObjectId(id));
      }
    }

    let orderMap = new Map();
    if (orderIds.length) {
      const orderDocs = await Order.find(
        { _id: { $in: orderIds } },
        { payerFirstName: 1, payerLastName: 1, payerEmail: 1 }
      ).lean();
      orderMap = new Map(orderDocs.map((doc) => [String(doc._id), doc]));
    }

    const rows = ticketDocs.map((ticket) => {
      let seat = splitSeat(ticket.seatId);
      const seatRawUpper = String(ticket.seatId || '').trim().toUpperCase();
      const zoneCandidate = seatRawUpper.startsWith('ZONE ')
        ? seatRawUpper.replace(/^ZONE\s+/, '')
        : seatRawUpper;
      if (!seat.section && zoneCandidate && ['DEBOUT', 'TBH7'].includes(zoneCandidate)) {
        seat = {
          section: zoneCandidate,
          row: '',
          seatNo: '',
          label: zoneCandidate
        };
      }
      const order = ticket.orderId ? orderMap.get(String(ticket.orderId)) : null;
      const scannedAt = ticket.scannedAt ? new Date(ticket.scannedAt) : null;
      const history = Array.isArray(ticket.scanHistory) ? ticket.scanHistory : [];
      const lastExit = [...history].reverse().find((entry) => entry?.action === 'exit');
      let statusLabel = 'Jamais scanné';
      let statusClass = 'status-pending';
      if (scannedAt) {
        statusLabel = `Entrée le ${formatDateTime(scannedAt)}`;
        statusClass = 'status-ok';
      } else if (lastExit?.when) {
        statusLabel = `Sorti le ${formatDateTime(lastExit.when)}`;
        statusClass = 'status-exit';
      }
      const searchIndex = [
        ticket?.holder?.firstName,
        ticket?.holder?.lastName,
        order?.payerFirstName,
        order?.payerLastName,
        order?.payerEmail
      ]
        .map((value) => String(value || '').toLowerCase())
        .join(' ');

      return {
        id: String(ticket._id),
        seat,
        holderFirstName: ticket?.holder?.firstName || '',
        holderLastName: ticket?.holder?.lastName || '',
        contactFirstName: order?.payerFirstName || '',
        contactLastName: order?.payerLastName || '',
        contactEmail: order?.payerEmail || '',
        tariffCode: ticket?.tariffCode || '',
        statusLabel,
        statusClass,
        scannedAt,
        scanCount: Number(ticket?.scanCount || 0),
        searchIndex,
        lastExit,
        ticket
      };
    });

    rows.sort((a, b) => {
      const keyA = [a.seat.section, a.seat.row, a.seat.seatNo, a.holderLastName, a.holderFirstName].join('|');
      const keyB = [b.seat.section, b.seat.row, b.seat.seatNo, b.holderLastName, b.holderFirstName].join('|');
      return keyA.localeCompare(keyB, 'fr');
    });

    const stats = summarizeTickets(ticketDocs);

    const hiddenCredentialInputs = [
      credentialParams.get('token') ? `<input type="hidden" name="token" value="${escapeHtml(credentialParams.get('token'))}">` : '',
      credentialParams.get('login') ? `<input type="hidden" name="login" value="${escapeHtml(credentialParams.get('login'))}">` : '',
      credentialParams.get('password') ? `<input type="hidden" name="password" value="${escapeHtml(credentialParams.get('password'))}">` : ''
    ].join('');

    const feedbackCode = String(req.query.feedback || '').trim();
    const feedback = safeFeedback(feedbackCode);

    const eventOptionsHtml = events.map((event) => {
      const key = String(event.slug || event._id);
      const labelDate = event.startsAt ? new Date(event.startsAt).toLocaleString('fr-FR') : '';
      const attrValue = escapeHtml(key);
      const label = `${event.name} — ${labelDate}`;
      return `<option value="${attrValue}"${key === selectedEventKey ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');

    const basePathValue = basePath();
    const guestlistBase = `${basePathValue}/control/guestlist`.replace(/\/{2,}/g, '/');

    const rowsHtml = rows.map((row) => {
      const seatLabel = row.seat.label || (row.ticket?.seatId ? String(row.ticket.seatId) : '');
      const searchAttr = escapeHtml(row.searchIndex);
      const encodedTicketId = encodeURIComponent(row.id);
      const enterAction = `${guestlistBase}/tickets/${encodedTicketId}/enter`.replace(/\/{2,}/g, '/');
      const exitAction = `${guestlistBase}/tickets/${encodedTicketId}/exit`.replace(/\/{2,}/g, '/');
      const actionButtons = `
        <form method="post" action="${escapeHtml(enterAction)}" class="inline-form">
          <input type="hidden" name="event" value="${escapeHtml(selectedEventKey)}">
          ${hiddenCredentialInputs}
          <button type="submit" class="btn btn-enter">Entrée</button>
        </form>
        <form method="post" action="${escapeHtml(exitAction)}" class="inline-form">
          <input type="hidden" name="event" value="${escapeHtml(selectedEventKey)}">
          ${hiddenCredentialInputs}
          <button type="submit" class="btn btn-exit">Sortie</button>
        </form>`;

      const statusExtra = row.scanCount > 1 && row.scannedAt
        ? ` · ${row.scanCount} passages`
        : row.scanCount > 0 && !row.scannedAt
          ? ` · ${row.scanCount} passage${row.scanCount > 1 ? 's' : ''}`
          : '';

      return `
        <tr data-search="${searchAttr}">
          <td>${escapeHtml(row.seat.section)}</td>
          <td>${escapeHtml(row.seat.row)}</td>
          <td>${escapeHtml(seatLabel)}</td>
          <td>${escapeHtml(row.holderFirstName)}</td>
          <td>${escapeHtml(row.holderLastName)}</td>
          <td>${escapeHtml(row.contactFirstName)}</td>
          <td>${escapeHtml(row.contactLastName)}</td>
          <td>${escapeHtml(row.contactEmail)}</td>
          <td>${escapeHtml(row.tariffCode)}</td>
          <td><span class="status ${row.statusClass}">${escapeHtml(row.statusLabel)}${escapeHtml(statusExtra)}</span></td>
          <td class="actions">${actionButtons}</td>
        </tr>`;
    }).join('');

    const assetBase = `${basePathValue}/dynamic/assets/`.replace(/\/{2,}/g, '/');
    const logoSrc = `${assetBase}logo.png`;
    const scanLink = `${basePathValue}/control/scan?event=${encodeURIComponent(selectedEventKey)}`.replace(/\/{2,}/g, '/');

    res.type('html').send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Liste des invités – ${escapeHtml(eventDoc.name)}</title>
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
  .pill-link { display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; border-radius: 999px; background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff; text-decoration: none; font-weight: 600; box-shadow: 0 10px 30px rgba(37, 99, 235, 0.4); transition: transform 0.15s ease, box-shadow 0.15s ease; }
  .pill-link:hover { transform: translateY(-1px); box-shadow: 0 16px 36px rgba(37, 99, 235, 0.55); }
  main { padding: 0 0 48px; }
  .page { max-width: none; margin: 0; display: grid; gap: 28px; }
  .info-block { padding: 32px 28px; }
  h1 { margin: 0; font-size: 28px; font-weight: 700; color: #f8fafc; }
  .muted { margin-top: 8px; color: #94a3b8; font-size: 14px; }
  .feedback { padding: 12px 16px; border-radius: 12px; font-weight: 500; margin-top: 20px; }
  .feedback.ok { background: rgba(34, 197, 94, 0.12); border: 1px solid rgba(34, 197, 94, 0.4); color: #4ade80; }
  .feedback.err { background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; }
  .stats { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 20px; }
  .stats span { background: #111c31; border: 1px solid #1e293b; border-radius: 12px; padding: 10px 14px; font-size: 14px; display: inline-flex; gap: 8px; align-items: center; color: #cbd5f5; }
  .stats span strong { font-size: 18px; color: #f8fafc; }
  .controls { display: flex; flex-wrap: wrap; gap: 20px; margin-top: 24px; align-items: flex-end; }
  .controls form, .controls label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: #cbd5f5; }
  select, input[type="search"] { appearance: none; padding: 10px 14px; font-size: 15px; background: #0f172a; border: 1px solid #1f2a41; border-radius: 10px; color: #f8fafc; min-width: 240px; box-shadow: 0 4px 20px rgba(15, 23, 42, 0.35) inset; }
  select:focus, input[type="search"]:focus { outline: 2px solid rgba(59, 130, 246, 0.4); outline-offset: 0; }
  .table-wrapper { background: #0f172a; border: 1px solid #1f2a41; border-radius: 0; padding: 12px 0 18px; box-shadow: 0 18px 38px rgba(15, 23, 42, 0.65); overflow-x: auto; margin: 0; }
  table { border-collapse: collapse; width: 100%; min-width: 960px; font-size: 14px; }
  thead th { position: sticky; top: 0; background: linear-gradient(180deg, rgba(30, 58, 138, 0.45), rgba(15, 23, 42, 0.9)); backdrop-filter: blur(6px); color: #e2e8f0; text-align: left; padding: 12px 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid rgba(148, 163, 184, 0.12); }
  tbody td { padding: 12px 14px; border-bottom: 1px solid rgba(30, 41, 59, 0.7); color: #cbd5f5; white-space: nowrap; }
  tbody tr:nth-child(even) td { background: rgba(15, 23, 42, 0.55); }
  tbody tr:hover td { background: rgba(30, 58, 138, 0.18); }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; min-width: 220px; }
  .inline-form { display: inline-flex; }
  .btn { display: inline-flex; align-items: center; justify-content: center; padding: 8px 14px; font-size: 13px; font-weight: 600; border-radius: 999px; border: 1px solid transparent; cursor: pointer; transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease; }
  .btn:hover { transform: translateY(-1px); }
  .btn-enter { background: linear-gradient(135deg, #0ea5e9, #2563eb); box-shadow: 0 12px 24px rgba(14, 165, 233, 0.35); color: #fff; }
  .btn-enter:hover { box-shadow: 0 18px 32px rgba(37, 99, 235, 0.45); }
  .btn-exit { background: linear-gradient(135deg, #f97316, #ea580c); box-shadow: 0 12px 24px rgba(249, 115, 22, 0.35); color: #fff; }
  .btn-exit:hover { box-shadow: 0 18px 32px rgba(234, 88, 12, 0.45); }
  .status { display: inline-flex; align-items: center; justify-content: center; padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .status-ok { background: rgba(34, 197, 94, 0.16); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.4); }
  .status-exit { background: rgba(249, 115, 22, 0.16); color: #fb923c; border: 1px solid rgba(249, 115, 22, 0.4); }
  .status-pending { background: rgba(148, 163, 184, 0.18); color: #cbd5f5; border: 1px solid rgba(148, 163, 184, 0.28); }
  @media (max-width: 768px) {
    .top-bar { flex-direction: column; align-items: flex-start; gap: 18px; }
    .pill-link { align-self: stretch; justify-content: center; }
    select, input[type="search"] { min-width: 100%; }
    .table-wrapper { padding: 8px 0 16px; }
    main { padding: 16px 0 40px; }
  }
</style>
</head>
<body>
  <header class="top-bar">
    <div class="brand">
      <img src="${escapeHtml(logoSrc)}" alt="BTS" onerror="this.style.display='none'" />
      <div class="title-block">
        <strong>Contrôle d'accès</strong>
        <span>Liste des invités</span>
      </div>
    </div>
    <a class="pill-link" href="${escapeHtml(scanLink)}" target="_blank" rel="noopener">Ouvrir le mode scan</a>
  </header>
  <main>
    <div class="page">
      <section class="info-block">
        <h1>${escapeHtml(eventDoc.name)}</h1>
        <p class="muted">${formatDateTime(eventDoc.startsAt)}</p>
        ${feedback ? `<div class="feedback ${feedback.kind}">${escapeHtml(feedback.text)}</div>` : ''}
        <div class="stats">
          <span><strong>${stats.total}</strong> billets</span>
          <span><strong>${stats.scanned}</strong> entrées</span>
          <span><strong>${stats.exits}</strong> sorties</span>
        </div>
        <div class="controls">
          <form method="get" class="event-form">
            ${hiddenCredentialInputs}
            <label>
              <span>Évènement</span>
              <select id="eventSelect" name="event" onchange="this.form.submit()">
                ${eventOptionsHtml}
              </select>
            </label>
          </form>
          <label class="filter">
            <span>Filtrer noms / email</span>
            <input type="search" id="filter" placeholder="Tapez un nom ou un email">
          </label>
        </div>
      </section>
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Section</th>
              <th>Rangée</th>
              <th>Siège</th>
              <th>Bénéficiaire · Prénom</th>
              <th>Bénéficiaire · Nom</th>
              <th>Contact · Prénom</th>
              <th>Contact · Nom</th>
              <th>Contact · Email</th>
              <th>Tarif</th>
              <th>Statut scan</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  </main>
  <script>
  (function(){
    const filterInput = document.getElementById('filter');
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    if (!filterInput || !rows.length) return;
    const normalize = (value) => value.trim().toLowerCase();
    const applyFilter = () => {
      const needle = normalize(filterInput.value || '');
      rows.forEach((row) => {
        if (!needle) {
          row.style.display = '';
          return;
        }
        const hay = row.getAttribute('data-search') || '';
        row.style.display = hay.includes(needle) ? '' : 'none';
      });
    };
    filterInput.addEventListener('input', applyFilter);
  })();
  </script>
</body>
</html>`);
  } catch (err) {
    res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"><h1>Erreur</h1><p>${escapeHtml(err.message || 'Not found')}</p>`);
  }
});

async function handleTicketAction(req, res, action) {
  const ticketId = String(req.params.ticketId || '').trim();
  const eventKey = String(req.body.event || '').trim();
  const now = new Date();
  const gateName = req.headers['x-gate'] || req.body?.gate || process.env.SCAN_GATE_NAME || 'control-panel';
  const token = String(req.body.token || '').trim();
  const login = String(req.body.login || '').trim();
  const password = String(req.body.password || '').trim();

  const params = new URLSearchParams();
  if (eventKey) params.set('event', eventKey);
  if (token) params.set('token', token);
  if (login) params.set('login', login);
  if (password) params.set('password', password);

  const actionForFeedback = action === 'exit' ? 'exit' : 'enter';
  let feedback = `${actionForFeedback}-fail`;

  try {
    const ticket = await Ticket.findById(ticketId);
    if (!ticket) {
      const paramsString = params.toString();
      const target = withBasePath(`/control/guestlist?${paramsString ? `${paramsString}&` : ''}feedback=${feedback}`);
      res.redirect(303, target);
      return;
    }

    const eventId = String(ticket.eventId || '');
    if (!Array.isArray(ticket.scanHistory)) ticket.scanHistory = [];

    if (action === 'enter') {
      const wasScanned = !!ticket.scannedAt;
      ticket.scannedAt = now;
      ticket.scannedBy = gateName;
      if (!wasScanned) ticket.scanCount = Number(ticket.scanCount || 0) + 1;
      ticket.scanHistory.push({ when: now, by: gateName, action: 'force' });
      await ticket.save();
      await ScanLog.create({ when: now, eventId, ticketId: ticket._id, ok: true, reason: wasScanned ? 'manual_enter_again' : 'manual_enter', gate: gateName });
      feedback = 'enter-ok';
    } else {
      const count = Number(ticket.scanCount || 0);
      ticket.scannedAt = null;
      ticket.scannedBy = gateName;
      if (count > 0) ticket.scanCount = Math.max(0, count - 1);
      ticket.scanHistory.push({ when: now, by: gateName, action: 'exit' });
      await ticket.save();
      await ScanLog.create({ when: now, eventId, ticketId: ticket._id, ok: true, reason: 'manual_exit', gate: gateName });
      feedback = 'exit-ok';
    }
  } catch (err) {
    req.log?.error?.({ err, ticketId, action }, 'guestlist_ticket_action_failed');
  }

  const paramsString = params.toString();
  const redirectTarget = withBasePath(`/control/guestlist?${paramsString ? `${paramsString}&` : ''}feedback=${feedback}`);
  res.redirect(303, redirectTarget);
}

router.post('/control/guestlist/tickets/:ticketId/:action(enter|exit)', requireScanner, async (req, res) => {
  const action = req.params.action;
  await handleTicketAction(req, res, action);
});

export default router;
