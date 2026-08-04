// src/routes/admin.js
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import mongoose from 'mongoose';
import { Order } from '../../models/Order.js';
import { Seat }  from '../../models/Seat.js';
import { Zone }  from '../../models/Zone.js';
import { Venue } from '../../models/Venue.js';
import { Season } from '../../models/Season.js';
import { Event } from '../../models/Event.js';
import { listPartnerConfigs } from '../../config/partners.js';
import { Tariff } from '../../models/Tariff.js';
import { TariffPrice } from '../../models/TariffPrice.js';
import { TariffPriceCatalog } from '../../models/TariffPriceCatalog.js';
import { Subscriber } from '../../models/Subscriber.js';
import { Ticket } from '../../models/Ticket.js';
import { ScanLog } from '../../models/ScanLog.js';
import { ZoneCatalog } from '../../models/ZoneCatalog.js';
import { SeatCatalog } from '../../models/SeatCatalog.js';
import { resolveLinePlacement, applyAttendancePatch, summarizeAttendance } from '../../utils/event-attendance.js';
import { isVirtualZoneSeatId } from '../../utils/seat-id.js';
import { exportOrdersCsv, exportSeatsCsv } from '../../services/exports.js';
import {
  registerDefaultAutomationTasks,
  ensureTask as ensureAutomationTask,
  createJob as createAutomationJob,
  runJob as runAutomationJob,
  runJobDetached as runAutomationJobDetached,
  listJobs as listAutomationJobs,
  getJob as getAutomationJob
} from '../../services/automation/index.js';
import { serializeJob as serializeAutomationJob } from '../../services/automation/serializers.js';
import { adminScriptGroups, getAdminScript } from '../../config/adminScripts.js';
import { AutomationJob } from '../../models/AutomationJob.js';
import { getRequestMetrics } from '../../services/requestMetrics.js';
import { marked } from 'marked';

const router = express.Router();

const ROOT_DIR = process.cwd();
const TEMPLATES_ROOT = path.resolve(ROOT_DIR, 'data_references');
// docs/ is the app's documented single source of truth (see docs/index.md's own
// "Cette arborescence docs/ est désormais la source de vérité"): the guides panel
// reads its table of contents rather than duplicating content elsewhere.
const GUIDES_ROOT = path.resolve(ROOT_DIR, 'docs');
const DATA_EXAMPLES_ROOT = path.resolve(ROOT_DIR, 'data_examples');
const CUSTOM_ROOT = path.resolve(ROOT_DIR, 'data/customization');
const DATA_TEMPLATES_ROOT = path.resolve(ROOT_DIR, 'data/templates');
const DATA_ASSETS_ROOT = path.resolve(ROOT_DIR, 'data/assets');
const DYNAMIC_ROOT = path.resolve(ROOT_DIR, 'public/dynamic');
const DYNAMIC_ASSETS_ROOT = path.resolve(DYNAMIC_ROOT, 'assets');
const DYNAMIC_VENUES_ROOT = path.resolve(DYNAMIC_ROOT, 'venues');
const PUBLIC_TEMPLATES_ROOT = path.resolve(ROOT_DIR, 'public/templates');
const OUTPUTS_ROOT = path.resolve(ROOT_DIR, 'data/outputs');
const INPUTS_ROOT = path.resolve(ROOT_DIR, 'data/inputs');
for (const dir of [OUTPUTS_ROOT, INPUTS_ROOT, DYNAMIC_ASSETS_ROOT, DYNAMIC_VENUES_ROOT]) {
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

const RESERVED_AUTOMATION_KEYS = new Set([
  'dryRun',
  'dry',
  'confirm',
  'metadata',
  'sync',
  'wait',
  'runMode',
  'params'
]);

function extractAutomationParams(body = {}) {
  if (!body || typeof body !== 'object') return {};
  const params = {};
  if (body.params && typeof body.params === 'object') {
    Object.assign(params, body.params);
  }
  for (const [key, value] of Object.entries(body)) {
    if (!RESERVED_AUTOMATION_KEYS.has(key)) {
      params[key] = value;
    }
  }
  return params;
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

function normalizeReturnUrl(raw = '') {
  const val = String(raw || '').trim();
  if (!val) return null;
  if (/^https?:\/\//i.test(val)) return val;
  const base = trimEndSlash(BASE_PATH || '');
  if (base && val.startsWith(`${base}/`)) return val;
  if (val.startsWith('/')) return urlFor(val);
  return null;
}

function extractReturnUrl(stdout = '') {
  if (!stdout) return null;
  const match = stdout.match(/returnUrl\s*[:=]\s*(\S+)/i);
  if (!match || !match[1]) return null;
  return normalizeReturnUrl(match[1]);
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

function listTemplatesRecursive(root, prefix = '') {
  const out = [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        out.push(...listTemplatesRecursive(full, rel));
      } else if (entry.isFile()) {
        const stats = fs.statSync(full);
        out.push({ name: entry.name, rel, size: stats.size, mtime: stats.mtime });
      }
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { body: raw, title: null, navExclude: false };
  const title = m[1].match(/^title:\s*(.+)$/m);
  const navExclude = /^nav_exclude:\s*true\s*$/m.test(m[1]);
  return { body: raw.slice(m[0].length), title: title ? title[1].trim() : null, navExclude };
}

// Guide list mirrors docs/index.md's own curated "Table des matières" (order and
// labels), so the admin panel stays in sync with whatever the doc maintainers
// list there without needing a parallel config. Falls back to a directory scan
// (skipping index.md and nav_exclude:true pages, e.g. the legacy 0x-*.md files)
// if that section can't be found.
function listGuides() {
  try {
    const indexRaw = fs.readFileSync(path.join(GUIDES_ROOT, 'index.md'), 'utf8');
    const tocSection = (indexRaw.split(/^##\s+Table des matières\s*$/m)[1] || '').split(/^##\s+/m)[0];
    const entries = [...tocSection.matchAll(/\[([^\]]+)\]\(([\w-]+\.md)\)/g)]
      .map(m => ({ title: m[1].trim(), rel: m[2] }));
    if (entries.length) return entries;
  } catch { /* fall through to directory scan */ }

  try {
    return fs.readdirSync(GUIDES_ROOT)
      .filter(name => name.endsWith('.md') && name !== 'index.md')
      .map(name => {
        let raw = '';
        try { raw = fs.readFileSync(path.join(GUIDES_ROOT, name), 'utf8'); } catch { return null; }
        const { title, navExclude } = parseFrontmatter(raw);
        if (navExclude) return null;
        const heading = raw.match(/^#\s+(.+)$/m);
        return { rel: name, title: title || (heading ? heading[1].trim() : name.replace(/\.md$/, '')) };
      })
      .filter(Boolean)
      .sort((a, b) => a.rel.localeCompare(b.rel));
  } catch {
    return [];
  }
}

function listCustomizationRecursive(root, prefix = '') {
  return listTemplatesRecursive(root, prefix)
    .filter(entry => entry.name.toLowerCase().endsWith('.json'));
}

function listVenueViews(rootDir = DYNAMIC_VENUES_ROOT) {
  try {
    const venueDirs = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);

    const views = [];
    for (const venueSlug of venueDirs) {
      const viewsDir = path.join(rootDir, venueSlug, 'views');
      let entries = [];
      try {
        entries = fs.readdirSync(viewsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.toLowerCase().endsWith('.svg')) continue;
        const slug = entry.name.replace(/\.svg$/i, '');
        views.push({
          slug,
          venueSlug,
          label: `${venueSlug} — ${slug}`
        });
      }
    }

    return views.sort((a, b) => {
      const venueCmp = String(a.venueSlug || '').localeCompare(String(b.venueSlug || ''));
      if (venueCmp !== 0) return venueCmp;
      return String(a.slug || '').localeCompare(String(b.slug || ''));
    });
  } catch (error) {
    console.error('[admin] unable to list venue views:', error?.message || error);
    return [];
  }
}

function listVenueResources(rootDir = DYNAMIC_VENUES_ROOT) {
  const venues = [];
  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true }).filter(e => e.isDirectory());
    for (const entry of entries) {
      const venueSlug = entry.name;
      const venueRoot = path.join(rootDir, venueSlug);
      const planPath = path.join(venueRoot, 'plan.svg');
      let plan = null;
      try {
        const stats = fs.statSync(planPath);
        if (stats.isFile()) {
          plan = {
            name: 'plan.svg',
            rel: `dynamic/venues/${venueSlug}/plan.svg`,
            size: stats.size,
            mtime: stats.mtime
          };
        }
      } catch {/* plan absent */}

      const views = [];
      const viewsDir = path.join(venueRoot, 'views');
      try {
        const viewEntries = fs.readdirSync(viewsDir, { withFileTypes: true });
        for (const viewEntry of viewEntries) {
          if (!viewEntry.isFile() || !viewEntry.name.toLowerCase().endsWith('.svg')) continue;
          const slug = viewEntry.name.replace(/\.svg$/i, '');
          const stats = fs.statSync(path.join(viewsDir, viewEntry.name));
          views.push({
            slug,
            rel: `dynamic/venues/${venueSlug}/views/${viewEntry.name}`,
            size: stats.size,
            mtime: stats.mtime
          });
        }
      } catch {/* ignore */ }

      venues.push({
        venueSlug,
        plan,
        views: views.sort((a, b) => a.slug.localeCompare(b.slug))
      });
    }
    venues.sort((a, b) => a.venueSlug.localeCompare(b.venueSlug));
  } catch {
    return venues;
  }
  return venues;
}

async function findEventByKey(eventKey) {
  if (!eventKey) return null;
  const key = String(eventKey).trim();
  if (!key) return null;
  if (mongoose.isValidObjectId(key)) {
    const byId = await Event.findById(key).lean();
    if (byId) return byId;
  }
  return await Event.findOne({ slug: key }).lean();
}

function normalizeAttendanceOrder(order) {
  if (!order) return null;
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const outLines = lines.map((line, index) => {
    const placement = resolveLinePlacement(line);
    const attendance = line?.attendance || null;
    return {
      index,
      sourceLineId: line?.sourceLineId || null,
      seatId: line?.seatId || '',
      zoneKey: line?.zoneKey || '',
      tariffCode: line?.tariffCode || '',
      priceCents: line?.priceCents || 0,
      holderFirstName: line?.holderFirstName || '',
      holderLastName: line?.holderLastName || '',
      attendance,
      placement
    };
  });

  return {
    id: String(order._id),
    parentOrderId: order.parentOrderId ? String(order.parentOrderId) : null,
    status: order.status,
    totalCents: order.totalCents,
    createdAt: order.createdAt,
    payerEmail: order.payerEmail || '',
    lineCount: outLines.length,
    lines: outLines
  };
}

function orderMatchesEvent(order, eventDoc) {
  if (!order || !eventDoc) return false;
  const eventIdStr = String(eventDoc._id);
  const direct = order.eventId ? String(order.eventId) : null;
  const metaId = order.meta?.eventId ? String(order.meta.eventId) : null;
  const metaSlug = order.meta?.eventSlug ? String(order.meta.eventSlug) : null;

  if (direct && direct === eventIdStr) return true;
  if (metaId && metaId === eventIdStr) return true;
  if (metaSlug && metaSlug === eventDoc.slug) return true;
  return false;
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
async function computeEventSeatCounts(eventDoc = null, orderMatch = null) {
  if (!eventDoc) return {};
  const seasonCode = eventDoc.seasonCode || null;
  const venueSlug = eventDoc.venueSlug || null;
  if (!seasonCode || !venueSlug) return {};

  const paidOrderMatch = orderMatch
    ? { ...orderMatch, status: 'paid' }
    : {
        status: 'paid',
        $or: [
          { eventId: eventDoc._id },
          { 'meta.eventId': String(eventDoc._id) }
        ]
      };

  const [seatsRaw, paidOrders] = await Promise.all([
    Seat.find(
      { seasonCode, venueSlug },
      { seatId: 1, zoneKey: 1, status: 1, _id: 0 }
    ).lean(),
    Order.find(paidOrderMatch, { lines: 1, _id: 0 }).lean()
  ]);

  const seatMap = new Map();
  for (const seat of seatsRaw || []) {
    const seatId = String(seat?.seatId || '').trim();
    if (!seatId) continue;
    seatMap.set(seatId, {
      seatId,
      status: String(seat?.status || 'available').toLowerCase()
    });
  }

  if (!seatMap.size) return {};

  for (const order of paidOrders || []) {
    for (const line of order?.lines || []) {
      const placement = resolveLinePlacement(line);
      if (!placement || placement.released) continue;
      const seatId = String(placement?.seatId || '').trim();
      if (!seatId || isVirtualZoneSeatId(seatId)) continue;
      if (!seatMap.has(seatId)) continue;
      const previous = seatMap.get(seatId);
      if (previous.status === 'booked') continue;
      seatMap.set(seatId, { ...previous, status: 'booked' });
    }
  }

  const counts = {};
  for (const { status } of seatMap.values()) {
    const key = status || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function mapSeatStateForPlan(statusRaw = '') {
  const st = String(statusRaw || '').trim().toLowerCase();
  if (!st) return 'available';
  if (st === 'booked' || st === 'sold') return 'booked';
  if (['busy', 'provisioned', 'blocked', 'held', 'hold'].includes(st)) return 'busy';
  return 'available';
}

function formatPersonLabel(firstName = '', lastName = '', email = '') {
  const fullName = [String(firstName || '').trim(), String(lastName || '').trim()]
    .filter(Boolean)
    .join(' ')
    .trim();
  const mail = String(email || '').trim();
  if (fullName && mail) return `${fullName} <${mail}>`;
  if (fullName) return fullName;
  if (mail) return mail;
  return '—';
}

function buildEventOrderMatch(eventDoc = null) {
  if (!eventDoc?._id) return null;
  const eventId = String(eventDoc._id);
  const eventSlug = String(eventDoc.slug || '').trim();
  return {
    $or: [
      { eventId },
      { 'meta.eventId': eventId },
      ...(eventSlug ? [{ 'meta.eventSlug': eventSlug }] : [])
    ]
  };
}

function prepareScriptCatalog() {
  const scriptGroups = adminScriptGroups
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(group => ({
      ...group,
      scripts: group.scripts
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    }));

  const scriptForms = {};
  const automationScripts = [];
  for (const group of scriptGroups) {
    for (const script of group.scripts) {
      if (script?.form?.fields?.length) {
        scriptForms[script.id] = script.form;
      }
      if (script?.automation?.taskId) {
        automationScripts.push({
          scriptId: script.id,
          taskId: script.automation.taskId,
          label: script.label,
          groupId: group.id,
          defaultDryRun: Boolean(script.automation.defaultDryRun),
          danger: Boolean(script.danger)
        });
      }
    }
  }

  return { scriptGroups, scriptForms, automationScripts };
}

// Static (config-derived, no I/O) — safe to compute once and reuse on every
// route so the topbar's "Operation" chapter dropdown always lists all
// chapters, not just on /operate (which builds its own copy for the page body).
const NAV_SCRIPT_GROUPS = prepareScriptCatalog().scriptGroups;

/* ===================== Page HTML ===================== */
router.get('/', (req, res) => {
  const view = (req.query.view || '').toString();

  // No ?view= → render the admin home page (intro + the three sections)
  // instead of redirecting into Operation. An explicit ?view= keeps the
  // old direct-redirect behavior for any bookmarked/typed links.
  if (!view) {
    const token = (req.query.token || '').toString();
    const tokenQuery = token ? `token=${encodeURIComponent(token)}` : '';
    const tokenSuffix = token ? `?${tokenQuery}` : '';
    return res.render('admin/index', {
      basePath: BASE_PATH || '',
      token,
      tokenQuery,
      tokenSuffix,
      urlFor,
      scriptGroups: NAV_SCRIPT_GROUPS,
      scriptForms: {},
      automationScripts: [],
      automationJobs: {},
      activeGroupId: null,
      outputsList: [],
      inputsList: [],
      operateOptions: {
        venues: [], seasons: [], events: [], partners: [], tariffCatalogs: [],
        inputFiles: [], assetFiles: [], customizationFiles: [], venueViews: []
      },
      viewMode: 'home',
      monitorTab: null,
      docTab: null,
      monitoring: null,
      planView: null,
      ordersView: null,
      ticketsView: null
    });
  }

  const qs = new URLSearchParams(req.query);
  qs.delete('view');
  const suffix = qs.toString();
  let target = urlFor('/admin/operate');
  if (view === 'monitor') target = urlFor('/admin/monitor');
  if (view === 'io') target = urlFor('/admin/operate/io');
  if (view === 'templates') target = urlFor('/admin/doc');
  if (view === 'plan') target = urlFor('/admin/plan');
  if (view === 'orders') target = urlFor('/admin/orders');
  if (view === 'tickets') target = urlFor('/admin/tickets');
  return res.redirect(302, `${target}${suffix ? `?${suffix}` : ''}`);
});

router.get('/operate/io', (req, res) => {
  const token = (req.query.token || '').toString();
  const tokenQuery = token ? `token=${encodeURIComponent(token)}` : '';
  const tokenSuffix = token ? `?${tokenQuery}` : '';

  const outputsList = listFiles(OUTPUTS_ROOT);
  const inputsList = listFiles(INPUTS_ROOT);
  const venueViews = listVenueViews();

  return res.render('admin/index', {
    basePath: BASE_PATH || '',
    token,
    tokenQuery,
    tokenSuffix,
    urlFor,
    scriptGroups: NAV_SCRIPT_GROUPS,
    scriptForms: {},
    automationScripts: [],
    automationJobs: {},
    activeGroupId: null,
    outputsList,
    inputsList,
    operateOptions: {
      venues: [],
      seasons: [],
      events: [],
      partners: [],
      tariffCatalogs: [],
      inputFiles: inputsList.map(file => file.name),
      assetFiles: inputsList.map(file => file.name),
      customizationFiles: inputsList.map(file => file.name),
      venueViews
    },
    viewMode: 'io',
    monitorTab: 'tariffs',
    docTab: 'references',
    monitoring: null,
    planView: null,
    ordersView: null,
    ticketsView: null
  });
});

const DOC_TAB_OPTIONS = new Set(['references', 'examples', 'guides']);

router.get('/doc', (req, res) => {
  const token = (req.query.token || '').toString();
  const tokenQuery = token ? `token=${encodeURIComponent(token)}` : '';
  const tokenSuffix = token ? `?${tokenQuery}` : '';
  // No ?docTab= → show the Documentation overview page instead of
  // defaulting to "guides" (see the "!docTab" intro block in the view).
  const docTab = DOC_TAB_OPTIONS.has((req.query.docTab || '').toString())
    ? req.query.docTab.toString()
    : null;

  const emailTemplates = listTemplatesRecursive(path.join(TEMPLATES_ROOT, 'templates', 'email'));
  const ticketTemplates = listTemplatesRecursive(path.join(TEMPLATES_ROOT, 'templates', 'tickets'));
  const assetTemplates  = listTemplatesRecursive(path.join(TEMPLATES_ROOT, 'assets'));
  const csvTemplates   = listTemplatesRecursive(path.join(TEMPLATES_ROOT, 'csv'));
  const envTemplates   = listTemplatesRecursive(path.join(TEMPLATES_ROOT, 'env'));
  const svgTemplates   = listTemplatesRecursive(path.join(TEMPLATES_ROOT, 'svg'));
  const customization  = listTemplatesRecursive(path.join(TEMPLATES_ROOT, 'customization'));
  const dataExamplesList = listTemplatesRecursive(DATA_EXAMPLES_ROOT);

  const guidesList = docTab === 'guides' ? listGuides() : [];
  let activeGuide = null;
  if (docTab === 'guides') {
    const requested = (req.query.guide || '').toString();
    const match = guidesList.find(g => g.rel === requested) || guidesList[0] || null;
    if (match) {
      try {
        const abs = resolveInside(GUIDES_ROOT, match.rel);
        const raw = fs.readFileSync(abs, 'utf8');
        const { body } = parseFrontmatter(raw);
        // Rewrite relative links to sibling guides (e.g. "installation.md") into
        // in-app guide links so cross-references stay inside the panel instead
        // of 404ing (docs/*.md isn't served as static content).
        const guideQuery = tokenQuery ? `&${tokenQuery}` : '';
        const linked = body.replace(/\]\(([\w-]+\.md)(#[^)]*)?\)/g, (m, file, anchor) =>
          `](${urlFor('/admin/doc')}?docTab=guides&guide=${encodeURIComponent(file)}${guideQuery}${anchor || ''})`);
        activeGuide = { rel: match.rel, title: match.title, html: marked.parse(linked) };
      } catch { /* guide unreadable — leave activeGuide null */ }
    }
  }

  return res.render('admin/index', {
    basePath: BASE_PATH || '',
    token,
    tokenQuery,
    tokenSuffix,
    urlFor,
    scriptGroups: NAV_SCRIPT_GROUPS,
    scriptForms: {},
    automationScripts: [],
    automationJobs: {},
    activeGroupId: null,
    outputsList: [],
    inputsList: [],
    templatesEmail: emailTemplates,
    templatesTickets: ticketTemplates,
    templatesAssets: assetTemplates,
    templatesCsv: csvTemplates,
    templatesEnv: envTemplates,
    templatesSvg: svgTemplates,
    customizationList: customization,
    dataExamplesList,
    guidesList,
    activeGuide,
    operateOptions: {
      venues: [],
      seasons: [],
      events: [],
      partners: [],
      tariffCatalogs: [],
      inputFiles: [],
      assetFiles: [],
      venueViews: []
    },
    viewMode: 'templates',
    docTab,
    monitorTab: 'tariffs',
    monitoring: null,
    planView: null,
    ordersView: null,
    ticketsView: null
  });
});

router.get('/plan', async (req, res) => {
  const token = (req.query.token || '').toString();
  const tokenQuery = token ? `token=${encodeURIComponent(token)}` : '';
  const tokenSuffix = token ? `?${tokenQuery}` : '';

  const seasonsRaw = await Season.find({}).sort({ code: -1 }).lean();
  const defaultSeason = seasonsRaw.find(s => s.active) || seasonsRaw[0] || null;
  const selectedSeasonCodeRaw = typeof req.query.season === 'string' && req.query.season
    ? req.query.season
    : (defaultSeason?.code || null);
  const selectedSeason = seasonsRaw.find(s => s.code === selectedSeasonCodeRaw) || defaultSeason || null;
  const selectedSeasonCode = selectedSeason?.code || selectedSeasonCodeRaw || null;

  const eventsRaw = await Event.find(selectedSeasonCode ? { seasonCode: selectedSeasonCode } : {})
    .sort({ startsAt: 1 })
    .lean();
  const selectedEventSlug = typeof req.query.event === 'string' && req.query.event
    ? req.query.event
    : (eventsRaw[0]?.slug || null);
  const selectedEvent = eventsRaw.find(e => e.slug === selectedEventSlug) || eventsRaw[0] || null;

  const effectiveSeasonCode = selectedEvent?.seasonCode || selectedSeasonCode || null;
  const effectiveVenueSlug = selectedEvent?.venueSlug || selectedSeason?.venueSlug || null;

  let planUrl = null;
  let seats = [];
  let seatDetailsById = {};
  let seatCounts = {};

  if (effectiveSeasonCode && effectiveVenueSlug) {
    const planAbs = path.join(DYNAMIC_VENUES_ROOT, effectiveVenueSlug, 'plan.svg');
    try {
      const stats = fs.statSync(planAbs);
      if (stats.isFile()) {
        planUrl = urlFor(`/dynamic/venues/${encodeURIComponent(effectiveVenueSlug)}/plan.svg`);
      }
    } catch {}

    const seatsRaw = await Seat.find(
      { seasonCode: effectiveSeasonCode, venueSlug: effectiveVenueSlug },
      { seatId: 1, status: 1, _id: 0 }
    ).lean();

    const seatStatusById = new Map();
    for (const seat of seatsRaw || []) {
      const seatId = String(seat?.seatId || '').trim();
      if (!seatId) continue;
      seatStatusById.set(seatId, mapSeatStateForPlan(seat?.status));
    }

    if (selectedEvent?._id) {
      const eventId = String(selectedEvent._id);
      const eventSlug = String(selectedEvent.slug || '').trim();
      const eventOrders = await Order.find(
        {
          status: { $in: ['paid', 'tobepaid'] },
          $or: [
            { eventId },
            { 'meta.eventId': eventId },
            ...(eventSlug ? [{ 'meta.eventSlug': eventSlug }] : [])
          ]
        },
        {
          _id: 1,
          status: 1,
          payerFirstName: 1,
          payerLastName: 1,
          payerEmail: 1,
          lines: 1,
          createdAt: 1
        }
      )
        .sort({ createdAt: -1 })
        .lean();

      seatDetailsById = {};
      for (const order of eventOrders || []) {
        for (const line of order?.lines || []) {
          const placement = resolveLinePlacement(line);
          if (placement?.released) continue;
          const seatId = String(placement?.seatId || line?.seatId || '').trim();
          if (!seatId || isVirtualZoneSeatId(seatId)) continue;
          if (!seatStatusById.has(seatId)) continue;

          seatStatusById.set(seatId, 'booked');
          if (seatDetailsById[seatId]) continue;

          seatDetailsById[seatId] = {
            beneficiary: [String(line?.holderFirstName || '').trim(), String(line?.holderLastName || '').trim()].filter(Boolean).join(' ') || '—',
            payer: formatPersonLabel(order?.payerFirstName, order?.payerLastName, order?.payerEmail),
            tariff: String(line?.tariffCode || '').trim() || '—',
            orderId: String(order?._id || '').trim() || '—',
            orderStatus: String(order?.status || '').trim() || '—'
          };
        }
      }
    }

    seats = Array.from(seatStatusById.entries())
      .map(([seatId, status]) => ({ seatId, status }))
      .sort((a, b) => a.seatId.localeCompare(b.seatId, 'fr', { numeric: true, sensitivity: 'base' }));

    seatCounts = seats.reduce((acc, seat) => {
      const key = String(seat.status || 'unknown');
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }

  return res.render('admin/index', {
    basePath: BASE_PATH || '',
    token,
    tokenQuery,
    tokenSuffix,
    urlFor,
    scriptGroups: NAV_SCRIPT_GROUPS,
    scriptForms: {},
    automationScripts: [],
    automationJobs: {},
    activeGroupId: null,
    outputsList: [],
    inputsList: [],
    operateOptions: {
      venues: [],
      seasons: [],
      events: [],
      partners: [],
      tariffCatalogs: [],
      inputFiles: [],
      assetFiles: [],
      venueViews: []
    },
    viewMode: 'plan',
    monitorTab: 'tariffs',
    docTab: 'references',
    monitoring: null,
    ordersView: null,
    ticketsView: null,
    planView: {
      seasons: (seasonsRaw || []).map(s => ({
        code: s.code,
        name: s.name || '',
        active: Boolean(s.active)
      })),
      events: (eventsRaw || []).map(ev => ({
        id: String(ev._id),
        slug: ev.slug,
        name: ev.name || '',
        startsAt: ev.startsAt || null,
        venueSlug: ev.venueSlug || null,
        isOnSale: Boolean(ev.isOnSale)
      })),
      selectedSeasonCode,
      selectedEventSlug: selectedEvent ? selectedEvent.slug : null,
      selectedEvent: selectedEvent
        ? {
            id: String(selectedEvent._id),
            slug: selectedEvent.slug,
            name: selectedEvent.name || '',
            startsAt: selectedEvent.startsAt || null,
            venueSlug: selectedEvent.venueSlug || null,
            isOnSale: Boolean(selectedEvent.isOnSale)
          }
        : null,
      venueSlug: effectiveVenueSlug,
      seasonCode: effectiveSeasonCode,
      planUrl,
      seats,
      seatDetailsById,
      seatCounts
    }
  });
});

router.get('/orders', async (req, res) => {
  const token = (req.query.token || '').toString();
  const tokenQuery = token ? `token=${encodeURIComponent(token)}` : '';
  const tokenSuffix = token ? `?${tokenQuery}` : '';

  const seasonsRaw = await Season.find({}).sort({ code: -1 }).lean();
  const defaultSeason = seasonsRaw.find(s => s.active) || seasonsRaw[0] || null;
  const selectedSeasonCodeRaw = typeof req.query.season === 'string' && req.query.season
    ? req.query.season
    : (defaultSeason?.code || null);
  const selectedSeason = seasonsRaw.find(s => s.code === selectedSeasonCodeRaw) || defaultSeason || null;
  const selectedSeasonCode = selectedSeason?.code || selectedSeasonCodeRaw || null;

  const eventsRaw = await Event.find(selectedSeasonCode ? { seasonCode: selectedSeasonCode } : {})
    .sort({ startsAt: 1 })
    .lean();
  const selectedEventSlug = typeof req.query.event === 'string' && req.query.event
    ? req.query.event
    : (eventsRaw[0]?.slug || null);
  const selectedEvent = eventsRaw.find(e => e.slug === selectedEventSlug) || eventsRaw[0] || null;

  let rows = [];
  if (selectedEvent) {
    const eventMatch = buildEventOrderMatch(selectedEvent);
    const orderMatch = eventMatch || {};
    const ordersRaw = await Order.find(
      orderMatch,
      {
        _id: 1,
        createdAt: 1,
        status: 1,
        payerFirstName: 1,
        payerLastName: 1,
        payerEmail: 1,
        totalCents: 1,
        lines: 1
      }
    )
      .sort({ createdAt: -1 })
      .limit(2500)
      .lean();

    rows = ordersRaw.map((order) => {
      const beneficiaries = [];
      const beneficiarySet = new Set();
      const tariffs = new Set();
      for (const line of order?.lines || []) {
        const fullName = [String(line?.holderFirstName || '').trim(), String(line?.holderLastName || '').trim()]
          .filter(Boolean)
          .join(' ')
          .trim();
        if (fullName && !beneficiarySet.has(fullName.toLowerCase())) {
          beneficiarySet.add(fullName.toLowerCase());
          beneficiaries.push(fullName);
        }
        const tariff = String(line?.tariffCode || '').trim();
        if (tariff) tariffs.add(tariff);
      }
      const payerName = [String(order?.payerFirstName || '').trim(), String(order?.payerLastName || '').trim()]
        .filter(Boolean)
        .join(' ')
        .trim();
      const payerEmail = String(order?.payerEmail || '').trim();
      const searchIndex = [
        ...beneficiaries,
        payerName,
        payerEmail
      ]
        .join(' ')
        .toLowerCase();
      return {
        id: String(order?._id || ''),
        createdAt: order?.createdAt || null,
        status: String(order?.status || ''),
        lineCount: Array.isArray(order?.lines) ? order.lines.length : 0,
        totalCents: Number(order?.totalCents || 0),
        beneficiaries,
        payerName: payerName || '—',
        payerEmail: payerEmail || '—',
        tariffs: Array.from(tariffs),
        searchIndex
      };
    });
  }

  return res.render('admin/index', {
    basePath: BASE_PATH || '',
    token,
    tokenQuery,
    tokenSuffix,
    urlFor,
    scriptGroups: NAV_SCRIPT_GROUPS,
    scriptForms: {},
    automationScripts: [],
    automationJobs: {},
    activeGroupId: null,
    outputsList: [],
    inputsList: [],
    operateOptions: {
      venues: [],
      seasons: [],
      events: [],
      partners: [],
      tariffCatalogs: [],
      inputFiles: [],
      assetFiles: [],
      venueViews: []
    },
    viewMode: 'orders',
    monitorTab: 'tariffs',
    docTab: 'references',
    monitoring: null,
    planView: null,
    ticketsView: null,
    ordersView: {
      seasons: (seasonsRaw || []).map(s => ({
        code: s.code,
        name: s.name || '',
        active: Boolean(s.active)
      })),
      events: (eventsRaw || []).map(ev => ({
        id: String(ev._id),
        slug: ev.slug,
        name: ev.name || '',
        startsAt: ev.startsAt || null,
        venueSlug: ev.venueSlug || null
      })),
      selectedSeasonCode,
      selectedEventSlug: selectedEvent ? selectedEvent.slug : null,
      selectedEvent: selectedEvent
        ? {
            id: String(selectedEvent._id),
            slug: selectedEvent.slug,
            name: selectedEvent.name || '',
            startsAt: selectedEvent.startsAt || null,
            venueSlug: selectedEvent.venueSlug || null
          }
        : null,
      rows
    }
  });
});

router.get('/tickets', async (req, res) => {
  const token = (req.query.token || '').toString();
  const tokenQuery = token ? `token=${encodeURIComponent(token)}` : '';
  const tokenSuffix = token ? `?${tokenQuery}` : '';

  const seasonsRaw = await Season.find({}).sort({ code: -1 }).lean();
  const defaultSeason = seasonsRaw.find(s => s.active) || seasonsRaw[0] || null;
  const selectedSeasonCodeRaw = typeof req.query.season === 'string' && req.query.season
    ? req.query.season
    : (defaultSeason?.code || null);
  const selectedSeason = seasonsRaw.find(s => s.code === selectedSeasonCodeRaw) || defaultSeason || null;
  const selectedSeasonCode = selectedSeason?.code || selectedSeasonCodeRaw || null;

  const eventsRaw = await Event.find(selectedSeasonCode ? { seasonCode: selectedSeasonCode } : {})
    .sort({ startsAt: 1 })
    .lean();
  const selectedEventSlug = typeof req.query.event === 'string' && req.query.event
    ? req.query.event
    : (eventsRaw[0]?.slug || null);
  const selectedEvent = eventsRaw.find(e => e.slug === selectedEventSlug) || eventsRaw[0] || null;

  let rows = [];
  if (selectedEvent) {
    const eventId = String(selectedEvent._id);
    const eventSlug = String(selectedEvent.slug || '').trim();
    const eventKeys = [eventId, eventSlug].filter(Boolean);

    const ticketsRaw = await Ticket.find(
      { eventId: { $in: eventKeys } },
      {
        _id: 1,
        seatId: 1,
        tariffCode: 1,
        holder: 1,
        orderId: 1,
        createdAt: 1,
        scannedAt: 1,
        scanCount: 1
      }
    )
      .sort({ seatId: 1, createdAt: -1 })
      .limit(5000)
      .lean();

    const orderIds = [];
    const seenOrderIds = new Set();
    for (const ticket of ticketsRaw || []) {
      const id = String(ticket?.orderId || '').trim();
      if (!id || !mongoose.isValidObjectId(id) || seenOrderIds.has(id)) continue;
      seenOrderIds.add(id);
      orderIds.push(new mongoose.Types.ObjectId(id));
    }

    let orderMap = new Map();
    if (orderIds.length) {
      const ordersRaw = await Order.find(
        { _id: { $in: orderIds } },
        { payerFirstName: 1, payerLastName: 1, payerEmail: 1 }
      ).lean();
      orderMap = new Map(
        ordersRaw.map(order => [String(order?._id || ''), order])
      );
    }

    rows = (ticketsRaw || []).map((ticket) => {
      const holderName = [String(ticket?.holder?.firstName || '').trim(), String(ticket?.holder?.lastName || '').trim()]
        .filter(Boolean)
        .join(' ')
        .trim();
      const holderEmail = String(ticket?.holder?.email || '').trim();
      const order = ticket?.orderId ? orderMap.get(String(ticket.orderId)) : null;
      const contactName = [String(order?.payerFirstName || '').trim(), String(order?.payerLastName || '').trim()]
        .filter(Boolean)
        .join(' ')
        .trim();
      const contactEmail = String(order?.payerEmail || '').trim();
      const searchIndex = [
        holderName,
        holderEmail,
        contactName,
        contactEmail
      ]
        .join(' ')
        .toLowerCase();
      return {
        id: String(ticket?._id || ''),
        createdAt: ticket?.createdAt || null,
        scannedAt: ticket?.scannedAt || null,
        scanCount: Number(ticket?.scanCount || 0),
        seatId: String(ticket?.seatId || '').trim() || '—',
        tariffCode: String(ticket?.tariffCode || '').trim() || '—',
        holderName: holderName || '—',
        holderEmail: holderEmail || '—',
        contactName: contactName || '—',
        contactEmail: contactEmail || '—',
        orderId: ticket?.orderId ? String(ticket.orderId) : '—',
        searchIndex
      };
    });
  }

  return res.render('admin/index', {
    basePath: BASE_PATH || '',
    token,
    tokenQuery,
    tokenSuffix,
    urlFor,
    scriptGroups: NAV_SCRIPT_GROUPS,
    scriptForms: {},
    automationScripts: [],
    automationJobs: {},
    activeGroupId: null,
    outputsList: [],
    inputsList: [],
    operateOptions: {
      venues: [],
      seasons: [],
      events: [],
      partners: [],
      tariffCatalogs: [],
      inputFiles: [],
      assetFiles: [],
      venueViews: []
    },
    viewMode: 'tickets',
    monitorTab: 'tariffs',
    docTab: 'references',
    monitoring: null,
    planView: null,
    ordersView: null,
    ticketsView: {
      seasons: (seasonsRaw || []).map(s => ({
        code: s.code,
        name: s.name || '',
        active: Boolean(s.active)
      })),
      events: (eventsRaw || []).map(ev => ({
        id: String(ev._id),
        slug: ev.slug,
        name: ev.name || '',
        startsAt: ev.startsAt || null,
        venueSlug: ev.venueSlug || null
      })),
      selectedSeasonCode,
      selectedEventSlug: selectedEvent ? selectedEvent.slug : null,
      selectedEvent: selectedEvent
        ? {
            id: String(selectedEvent._id),
            slug: selectedEvent.slug,
            name: selectedEvent.name || '',
            startsAt: selectedEvent.startsAt || null,
            venueSlug: selectedEvent.venueSlug || null
          }
        : null,
      rows
    }
  });
});

router.get('/operate', async (req, res) => {
  if (req.query.view === 'io') {
    const qs = new URLSearchParams(req.query);
    qs.delete('view');
    const suffix = qs.toString();
    const target = urlFor('/admin/operate/io');
    return res.redirect(302, `${target}${suffix ? `?${suffix}` : ''}`);
  }

  const token = (req.query.token || '').toString();
  const tokenQuery = token ? `token=${encodeURIComponent(token)}` : '';
  const tokenSuffix = token ? `?${tokenQuery}` : '';

  const { scriptGroups, scriptForms, automationScripts } = prepareScriptCatalog();

  // No ?group= → show the Operation overview page instead of defaulting to
  // the first chapter (see the "!activeGroupId" intro block in the view).
  const activeGroupId = typeof req.query.group === 'string' && req.query.group
    ? req.query.group
    : null;

  const outputsList = listFiles(OUTPUTS_ROOT);
  const inputsList = listFiles(INPUTS_ROOT);
  const dynamicAssetsList = listFiles(DYNAMIC_ASSETS_ROOT);
  const customizationList = listCustomizationRecursive(CUSTOM_ROOT);
  const venueViews = listVenueViews();
  let operateOptions = {
    venues: [],
    seasons: [],
    events: [],
    partners: [],
    tariffCatalogs: [],
    inputFiles: inputsList.map(file => file.name),
    assetFiles: inputsList.map(file => file.name),
    customizationFiles: inputsList.map(file => file.name),
    venueViews
  };

  try {
    const [
      venuesRaw,
      seasonsRaw,
      eventsRaw,
      tariffCatalogsAgg,
      partnersRaw
    ] = await Promise.all([
      Venue.find({}).sort({ slug: 1 }).lean(),
      Season.find({}).sort({ code: -1 }).lean(),
      Event.find({}).sort({ startsAt: -1 }).lean(),
      TariffPriceCatalog.aggregate([
        { $group: { _id: '$catalogSlug', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      Promise.resolve(listPartnerConfigs())
    ]);

    operateOptions = {
      venues: venuesRaw.map(v => ({ slug: v.slug, name: v.name || '' })),
      seasons: seasonsRaw.map(s => ({ code: s.code, name: s.name || '' })),
      events: eventsRaw.map(ev => ({
        slug: ev.slug,
        name: ev.name || '',
        startsAt: ev.startsAt || null
      })),
      partners: partnersRaw.map(p => ({ slug: p.slug, name: p.name || '' })),
      tariffCatalogs: tariffCatalogsAgg
        .map(entry => entry?._id)
        .filter(Boolean),
      inputFiles: inputsList.map(file => file.name),
      assetFiles: inputsList.map(file => file.name),
      customizationFiles: inputsList.map(file => file.name),
      venueViews
    };
  } catch (error) {
    console.error('[admin] operate options fetch error:', error?.message || error);
  }
  const automationJobs = {};

  if (automationScripts.length > 0) {
    const jobTuples = await Promise.all(
      automationScripts.map(async (entry) => {
        try {
          const jobs = await listAutomationJobs({
            scriptId: entry.taskId,
            limit: 10
          });
          return [
            entry.scriptId,
            jobs.map(job => serializeAutomationJob(job))
          ];
        } catch (error) {
          console.error('[admin] automation jobs fetch error:', error?.message || error);
          return [entry.scriptId, []];
        }
      })
    );
    for (const [scriptId, jobs] of jobTuples) {
      automationJobs[scriptId] = jobs;
    }
  }

  return res.render('admin/index', {
    basePath: BASE_PATH || '',
    token,
    tokenQuery,
    tokenSuffix,
    urlFor,
    scriptGroups,
    scriptForms,
    automationScripts,
    automationJobs,
    activeGroupId,
    outputsList,
    inputsList,
    operateOptions,
    viewMode: 'operate',
    monitorTab: 'tariffs',
    docTab: 'references',
    monitoring: null,
    planView: null,
    ordersView: null,
    ticketsView: null
  });
});

router.get('/monitor', async (req, res) => {
  if (req.query.view === 'io') {
    const qs = new URLSearchParams(req.query);
    qs.delete('view');
    const suffix = qs.toString();
    const target = urlFor('/admin/operate/io');
    return res.redirect(302, `${target}${suffix ? `?${suffix}` : ''}`);
  }
  if (req.query.view === 'operate') {
    const qs = new URLSearchParams(req.query);
    qs.delete('view');
    const suffix = qs.toString();
    const target = urlFor('/admin/operate');
    return res.redirect(302, `${target}${suffix ? `?${suffix}` : ''}`);
  }

  const { automationScripts } = prepareScriptCatalog();
  const mongoState = mongoose.connection?.readyState;
  const mongoStateLabel = ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoState || 0];

  let pm2 = null;
  let recentLogs = [];
  try {
    const out = childProcess.execSync('pm2 jlist', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const rawList = JSON.parse(out);
    pm2 = rawList.map(p => ({
      name: p.name,
      pid: p.pid,
      status: p.pm2_env?.status,
      uptime: p.pm2_env?.pm_uptime ? new Date(p.pm2_env.pm_uptime).toISOString() : null,
      restarts: p.pm2_env?.restart_time ?? 0,
      mem: p.monit?.memory ?? 0,
      cpu: p.monit?.cpu ?? 0
    }));

    const target = rawList.find(p => p.name === 'bts') || rawList[0];
    const tailFile = (filePath, stream) => {
      if (!filePath || !fs.existsSync(filePath)) return [];
      const content = fs.readFileSync(filePath, 'utf8');
      return content.trim().split(/\n+/).filter(Boolean).slice(-15).map(line => ({ stream, line }));
    };
    if (target) {
      recentLogs = [
        ...tailFile(target.pm2_env?.pm_out_log_path, 'out'),
        ...tailFile(target.pm2_env?.pm_err_log_path, 'error')
      ];
    }
  } catch { /* ignore */ }

  let diskUsage = null;
  try {
    const out = childProcess.execSync('df -k .', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.trim().split(/\n+/);
    if (lines.length >= 2) {
      const parts = lines[1].trim().split(/\s+/);
      if (parts.length >= 5) {
        const filesystem = parts[0];
        const sizeKB = Number(parts[1]) || 0;
        const usedKB = Number(parts[2]) || 0;
        const availKB = Number(parts[3]) || 0;
        const pctRaw = parts[4] || '';
        const usedPct = pctRaw.endsWith('%') ? Number(pctRaw.replace('%', '')) : (sizeKB ? Math.round((usedKB / sizeKB) * 100) : null);
        diskUsage = { filesystem, sizeKB, usedKB, availKB, usedPct };
      }
    }
  } catch { /* ignore */ }

  let mongoConnections = null;
  let mongoOpCounters = null;
  try {
    const admin = mongoose.connection.db?.admin();
    if (admin) {
      const status = await admin.serverStatus();
      mongoConnections = status.connections || null;
      mongoOpCounters = status.opcounters || null;
    }
  } catch { /* ignore */ }

  let activeAutomationJobs = null;
  try {
    activeAutomationJobs = await AutomationJob.countDocuments({ status: { $in: ['queued', 'running'] } });
  } catch { /* ignore */ }

  const requestActivity = getRequestMetrics();

  let dbCollections = [];
  try {
    const db = mongoose.connection.db;
    if (db) {
      const collInfos = await db.listCollections().toArray();
      for (const info of collInfos) {
        try {
          const statsAgg = await db.collection(info.name).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
          const stats = statsAgg[0]?.storageStats || {};
          dbCollections.push({
            name: info.name,
            count: stats.count ?? 0,
            sizeBytes: stats.size ?? 0,
            storageSizeBytes: stats.storageSize ?? 0
          });
        } catch {
          dbCollections.push({ name: info.name, count: null, sizeBytes: null, storageSizeBytes: null });
        }
      }
      dbCollections.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
    }
  } catch { /* ignore */ }

  const token = (req.query.token || '').toString();
  const tokenQuery = token ? `token=${encodeURIComponent(token)}` : '';
  const tokenSuffix = token ? `?${tokenQuery}` : '';

  const monitorTabOptions = new Set(['custo', 'system', 'venue', 'tariffs', 'seasons', 'events', 'partners']);
  // No ?monitorTab= → show the Monitoring overview page instead of
  // defaulting to "system" (see the "!monitorTab" intro block in the view).
  const monitorTab = monitorTabOptions.has(req.query.monitorTab) ? req.query.monitorTab : null;

  const dynamicAssetsList = listFiles(DYNAMIC_ASSETS_ROOT);
  const customizationList = listCustomizationRecursive(CUSTOM_ROOT);
  const dataTemplatesList = listTemplatesRecursive(DATA_TEMPLATES_ROOT);
  const dataAssetsList = listTemplatesRecursive(DATA_ASSETS_ROOT);
  const venueResources = listVenueResources();

  const [
    venuesRaw,
    seasonsRaw,
    eventsRaw,
    tariffsRaw,
    venueZoneCountsAgg,
    seatCatalogCountsAgg,
    partnersRaw,
    tariffPriceCatalogGroupsAgg
  ] = await Promise.all([
    Venue.find({}).sort({ slug: 1 }).lean(),
    Season.find({}).sort({ code: -1 }).lean(),
    Event.find({}).sort({ startsAt: -1 }).lean(),
    Tariff.find({}).sort({ priceTableKey: 1, sortOrder: 1, code: 1 }).lean(),
    ZoneCatalog.aggregate([
      { $group: { _id: '$venueSlug', count: { $sum: 1 } } }
    ]),
    SeatCatalog.aggregate([
      { $group: { _id: '$venueSlug', count: { $sum: 1 } } }
    ]),
    Promise.resolve(listPartnerConfigs()),
    TariffPriceCatalog.aggregate([
      {
        $group: {
          _id: { catalogSlug: '$catalogSlug', venueSlug: '$venueSlug' },
          count: { $sum: 1 },
          zoneKeys: { $addToSet: '$zoneKey' },
          tariffCodes: { $addToSet: '$tariffCode' },
          currency: { $first: '$currency' }
        }
      },
      { $sort: { '_id.catalogSlug': 1, '_id.venueSlug': 1 } }
    ])
  ]);

  const venueZoneCounts = new Map(venueZoneCountsAgg.map(entry => [entry._id || '', entry.count]));
  const seatCatalogCounts = new Map(seatCatalogCountsAgg.map(entry => [entry._id || '', entry.count]));
  const venueViewCounts = new Map((venueResources || []).map(v => [v.venueSlug, (v.views || []).length]));
  const venueHasPlan = new Map((venueResources || []).map(v => [v.venueSlug, Boolean(v.plan)]));

  const venuesList = venuesRaw.map(v => ({
    slug: v.slug,
    name: v.name,
    zoneCount: venueZoneCounts.get(v.slug) || 0,
    seatCount: seatCatalogCounts.get(v.slug) || 0,
    viewCount: venueViewCounts.get(v.slug) || 0,
    hasPlan: venueHasPlan.get(v.slug) || false,
    svgPath: v.svgPath
  }));

  const requestedMonitorVenueSlug = (req.query.monitorVenue || '').toString();
  const selectedMonitorVenue = venuesList.find(v => v.slug === requestedMonitorVenueSlug) || venuesList[0] || null;
  const selectedMonitorVenueSlug = selectedMonitorVenue ? selectedMonitorVenue.slug : '';

  let venueZoneDetails = [];
  if (selectedMonitorVenueSlug) {
    const [zonesRaw, zoneSeatCountsAgg] = await Promise.all([
      ZoneCatalog.find({ venueSlug: selectedMonitorVenueSlug }).sort({ key: 1 }).lean(),
      SeatCatalog.aggregate([
        { $match: { venueSlug: selectedMonitorVenueSlug } },
        { $group: { _id: '$zoneKey', count: { $sum: 1 } } }
      ])
    ]);
    const zoneSeatCounts = new Map(zoneSeatCountsAgg.map(entry => [entry._id || '', entry.count]));
    venueZoneDetails = zonesRaw.map(z => ({
      key: z.key,
      name: z.name || '',
      type: z.type,
      access: z.access,
      capacity: z.capacity || 0,
      quota: z.quota || 0,
      isActive: z.isActive,
      seatCount: zoneSeatCounts.get(z.key) || 0
    }));
  }

  const seasonsList = seasonsRaw.map(s => ({
    code: s.code,
    name: s.name,
    active: s.active,
    venueSlug: s.venueSlug || null,
    phaseCount: Array.isArray(s.phases) ? s.phases.length : 0
  }));

  const eventsList = eventsRaw.map(e => ({
    id: String(e._id),
    slug: e.slug,
    name: e.name,
    startsAt: e.startsAt,
    seasonCode: e.seasonCode,
    venueSlug: e.venueSlug,
    isOnSale: e.isOnSale
  }));

  const partnersList = (partnersRaw || []).map(p => ({
    slug: p.slug,
    name: p.name || '',
    paymentMode: p.paymentMode || '',
    allowPublicTariffs: Boolean(p.allowPublicTariffs),
    venueView: p.venueView || null
  }));

  const tariffsFull = tariffsRaw.map(t => ({
    code: t.code,
    label: t.label,
    active: t.active,
    priceTableKey: t.priceTableKey || null,
    requiresField: t.requiresField,
    fieldLabel: t.fieldLabel
  }));

  const tariffPriceCatalogGroups = tariffPriceCatalogGroupsAgg.map(g => ({
    catalogSlug: g._id.catalogSlug,
    venueSlug: g._id.venueSlug || null,
    entryCount: g.count,
    zoneCount: (g.zoneKeys || []).length,
    tariffCount: (g.tariffCodes || []).length,
    currency: g.currency || 'EUR',
    key: `${g._id.catalogSlug}|${g._id.venueSlug || ''}`
  }));

  const requestedCatalogKey = (req.query.catalogKey || '').toString();
  const selectedCatalogGroup = tariffPriceCatalogGroups.find(g => g.key === requestedCatalogKey)
    || tariffPriceCatalogGroups[0]
    || null;
  const selectedCatalogKey = selectedCatalogGroup ? selectedCatalogGroup.key : '';

  let tariffPriceCatalogEntries = [];
  if (selectedCatalogGroup) {
    const entriesRaw = await TariffPriceCatalog.find({
      catalogSlug: selectedCatalogGroup.catalogSlug,
      venueSlug: selectedCatalogGroup.venueSlug
    }).sort({ zoneKey: 1, tariffCode: 1 }).lean();
    tariffPriceCatalogEntries = entriesRaw.map(e => ({
      zoneKey: e.zoneKey,
      tariffCode: e.tariffCode,
      priceCents: e.priceCents,
      partnerPriceCents: e.partnerPriceCents,
      currency: e.currency || 'EUR'
    }));
  }

  const defaultSeason = seasonsRaw.find(s => s.active) || seasonsRaw[0] || null;
  const selectedSeasonCode = typeof req.query.season === 'string' && req.query.season
    ? req.query.season
    : (defaultSeason ? defaultSeason.code : null);
  const selectedSeason = seasonsRaw.find(s => s.code === selectedSeasonCode) || defaultSeason || null;

  const seasonDefaultVenue = selectedSeason?.venueSlug || null;
  const selectedVenueSlug = typeof req.query.venue === 'string' && req.query.venue
    ? req.query.venue
    : (seasonDefaultVenue || (venuesRaw[0]?.slug ?? null));

  const selectedSeasonLabel = selectedSeason?.name || selectedSeasonCode || null;

  const selectedEventSlug = typeof req.query.event === 'string' && req.query.event
    ? req.query.event
    : (eventsRaw[0]?.slug || null);
  const selectedEvent = eventsRaw.find(e => e.slug === selectedEventSlug) || eventsRaw[0] || null;
  const selectedEventId = selectedEvent ? String(selectedEvent._id) : null;

  const subscriptionMatch = {};
  if (selectedSeasonCode) subscriptionMatch.seasonCode = selectedSeasonCode;
  if (selectedVenueSlug) subscriptionMatch.venueSlug = selectedVenueSlug;

  let subscriptionOrders = [];
  let subscriptionOrderStats = {};
  let subscriptionSeatCounts = {};
  let subscriptionTickets = [];
  let subscriptionSeatsSample = [];

  if (selectedSeasonCode) {
    const [ordersRaw, orderStatsAgg, seatStatsAgg, ticketsRaw, seatsRaw] = await Promise.all([
      Order.find(subscriptionMatch)
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      Order.aggregate([
        { $match: subscriptionMatch },
        { $group: { _id: '$status', count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } }
      ]),
      Seat.aggregate([
        { $match: { seasonCode: selectedSeasonCode, ...(selectedVenueSlug ? { venueSlug: selectedVenueSlug } : {}) } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      Ticket.find({ seasonCode: selectedSeasonCode, ...(selectedVenueSlug ? { venueSlug: selectedVenueSlug } : {}) })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      Seat.find({ seasonCode: selectedSeasonCode, ...(selectedVenueSlug ? { venueSlug: selectedVenueSlug } : {}) })
        .sort({ updatedAt: -1 })
        .limit(20)
        .lean()
    ]);

    subscriptionOrders = ordersRaw.map(o => ({
      id: String(o._id),
      status: o.status,
      totalCents: o.totalCents,
      createdAt: o.createdAt,
      payerEmail: o.payerEmail,
      lineCount: Array.isArray(o.lines) ? o.lines.length : 0
    }));

    subscriptionOrderStats = orderStatsAgg.reduce((acc, row) => {
      acc[row._id || 'unknown'] = { count: row.count, totalCents: row.totalCents };
      return acc;
    }, {});

    subscriptionSeatCounts = seatStatsAgg.reduce((acc, row) => {
      acc[row._id || 'unknown'] = row.count;
      return acc;
    }, {});

    subscriptionTickets = ticketsRaw.map(t => ({
      id: String(t._id),
      seatId: t.seatId,
      tariffCode: t.tariffCode,
      eventId: t.eventId || null,
      createdAt: t.createdAt
    }));

    subscriptionSeatsSample = seatsRaw.map(s => ({
      seatId: s.seatId,
      zoneKey: s.zoneKey,
      status: s.status,
      updatedAt: s.updatedAt
    }));
  }

  const eventOrderMatch = selectedEventId
    ? {
        $or: [
          { eventId: selectedEventId },
          { 'meta.eventId': selectedEventId }
        ]
      }
    : null;
  let eventOrders = [];
  let eventOrderStats = {};
  let eventTickets = [];
  let eventSeatCounts = {};
  let eventSubscribers = [];
  let eventScans = [];
  let eventAttendance = { kept: 0, released: 0, moved: 0 };

  if (selectedEventId) {
    const [
      eventOrdersRaw,
      eventOrderStatsAgg,
      attendanceStatsAgg,
      eventTicketsRaw,
      eventSeatCountsRaw,
      eventSubscribersRaw,
      eventScansRaw
    ] = await Promise.all([
      Order.find(eventOrderMatch)
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      Order.aggregate([
        { $match: eventOrderMatch },
        { $group: { _id: '$status', count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } }
      ]),
      Order.aggregate([
        { $match: eventOrderMatch },
        { $unwind: '$lines' },
        { $group: { _id: '$lines.attendance.status', count: { $sum: 1 } } }
      ]),
      Ticket.find({ eventId: selectedEventId })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      selectedEvent
        ? computeEventSeatCounts(selectedEvent, eventOrderMatch)
        : Promise.resolve({}),
      selectedEvent
        ? Subscriber.find({ seasonCode: selectedEvent.seasonCode, venueSlug: selectedEvent.venueSlug })
            .sort({ updatedAt: -1 })
            .limit(20)
            .lean()
        : Promise.resolve([]),
      ScanLog.find({ eventId: selectedEventId })
        .sort({ when: -1 })
        .limit(50)
        .lean()
    ]);

    eventAttendance = { kept: 0, released: 0, moved: 0 };
    const attendanceAgg = Array.isArray(attendanceStatsAgg) ? attendanceStatsAgg : [];

    eventOrders = eventOrdersRaw.map(o => {
      const lines = Array.isArray(o.lines) ? o.lines : [];
      const attendance = { kept: 0, released: 0, moved: 0 };
      const overrides = [];

      for (const line of lines) {
        const rawStatus = String(line?.attendance?.status || 'kept').toLowerCase();
        const status = rawStatus === 'released' ? 'released' : rawStatus === 'moved' ? 'moved' : 'kept';
        attendance[status] += 1;
        eventAttendance[status] += 1;

        if (status !== 'kept') {
          const placement = resolveLinePlacement(line);
          overrides.push({
            status,
            seatId: placement.seatId || line.seatId || '',
            zoneKey: placement.zoneKey || line.zoneKey || '',
            note: line?.attendance?.note || ''
          });
        }
      }

      return {
        id: String(o._id),
        parentOrderId: o.parentOrderId ? String(o.parentOrderId) : null,
        status: o.status,
        totalCents: o.totalCents,
        createdAt: o.createdAt,
        payerEmail: o.payerEmail,
        lineCount: lines.length,
        attendance,
        overrides
      };
    });

    eventOrderStats = eventOrderStatsAgg.reduce((acc, row) => {
      acc[row._id || 'unknown'] = { count: row.count, totalCents: row.totalCents };
      return acc;
    }, {});

    for (const row of attendanceAgg) {
      const key = String(row?._id || 'kept').toLowerCase();
      if (key === 'released') eventAttendance.released = row.count || 0;
      else if (key === 'moved') eventAttendance.moved = row.count || 0;
      else eventAttendance.kept = (eventAttendance.kept || 0) + (row.count || 0);
    }

    eventTickets = eventTicketsRaw.map(t => ({
      id: String(t._id),
      seatId: t.seatId,
      zoneKey: t.zoneKey,
      tariffCode: t.tariffCode,
      scannedAt: t.scannedAt || null,
      createdAt: t.createdAt
    }));

    eventSeatCounts = (eventSeatCountsRaw && typeof eventSeatCountsRaw === 'object')
      ? eventSeatCountsRaw
      : {};

    eventSubscribers = eventSubscribersRaw.map(s => ({
      id: String(s._id),
      firstName: s.firstName || '',
      lastName: s.lastName || '',
      email: s.email || '',
      groupKey: s.groupKey || '',
      previousSeats: Array.isArray(s.previousSeasonSeats) ? s.previousSeasonSeats.slice(0, 5) : []
    }));

    eventScans = eventScansRaw.map(log => ({
      id: String(log._id),
      when: log.when || log.createdAt,
      gate: log.gate || '',
      ok: log.ok,
      reason: log.reason || '',
      qrValue: log.qrValue || ''
    }));
  }

  const serverInfo = {
    host: os.hostname(),
    nodeVersion: process.version,
    env: process.env.APP_ENV || 'unknown',
    basePath: process.env.BASE_PATH || '/',
    mongoState: mongoStateLabel
  };

  const monitoring = {
    summary: {
      serverInfo,
      mongoState: mongoStateLabel,
      mongoConnections,
      mongoOpCounters,
      dbCollections,
      recentLogs,
      pm2,
      diskUsage,
      requestActivity,
      activeAutomationJobs
    },
    lists: {
      venues: venuesList,
      selectedMonitorVenueSlug,
      venueZoneDetails,
      seasons: seasonsList,
      events: eventsList,
      tariffs: tariffsFull,
      tariffPriceCatalogGroups,
      selectedCatalogKey,
      tariffPriceCatalogEntries,
      partners: partnersList
    },
    subscription: {
      selectedSeasonCode,
      selectedSeasonLabel,
      selectedVenueSlug,
      orders: subscriptionOrders,
      orderStats: subscriptionOrderStats,
      seatCounts: subscriptionSeatCounts,
      tickets: subscriptionTickets,
      seats: subscriptionSeatsSample
    },
    event: {
      selectedEventSlug,
      selectedEvent: selectedEvent
        ? {
            slug: selectedEvent.slug,
            name: selectedEvent.name,
            startsAt: selectedEvent.startsAt,
            seasonCode: selectedEvent.seasonCode,
            venueSlug: selectedEvent.venueSlug,
            isOnSale: selectedEvent.isOnSale
          }
        : null,
      orders: eventOrders,
      orderStats: eventOrderStats,
      tickets: eventTickets,
      seatCounts: eventSeatCounts,
      attendance: eventAttendance,
      subscribers: eventSubscribers,
      scans: eventScans
    }
  };

  const automationJobs = {};
  if (automationScripts.length > 0) {
    try {
      const jobTuples = await Promise.all(
        automationScripts.map(async (entry) => {
          const jobs = await listAutomationJobs({
            scriptId: entry.taskId,
            limit: 10
          });
          return [entry.scriptId, jobs.map(job => serializeAutomationJob(job))];
        })
      );
      for (const [scriptId, jobs] of jobTuples) {
        automationJobs[scriptId] = jobs;
      }
    } catch (error) {
      console.error('[admin][monitor] automation jobs fetch error:', error?.message || error);
    }
  }

  return res.render('admin/index', {
    basePath: BASE_PATH || '',
    token,
    tokenQuery,
    tokenSuffix,
    urlFor,
    scriptGroups: NAV_SCRIPT_GROUPS,
    scriptForms: {},
    automationScripts,
    automationJobs,
    activeGroupId: null,
    outputsList: [],
    inputsList: [],
    viewMode: 'monitor',
    monitorTab,
    docTab: 'references',
    monitoring,
    planView: null,
    ordersView: null,
    ticketsView: null,
    dynamicAssetsList,
    venueResources,
    dataTemplatesList,
    dataAssetsList,
    customizationList
  });
});

/* ===================== Event attendance adjustments ===================== */

router.get('/events/:eventKey/orders/:orderId/attendance', async (req, res) => {
  try {
    const eventKey = String(req.params.eventKey || '').trim();
    const orderId = String(req.params.orderId || '').trim();
    if (!eventKey || !orderId) {
      return res.status(400).json({ ok: false, error: 'eventKey and orderId are required' });
    }

    const eventDoc = await findEventByKey(eventKey);
    if (!eventDoc) {
      return res.status(404).json({ ok: false, error: 'Event not found' });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }
    if (!orderMatchesEvent(order, eventDoc)) {
      return res.status(404).json({ ok: false, error: 'Order not linked to this event' });
    }

    const payload = normalizeAttendanceOrder(order);
    const attendance = summarizeAttendance(order.lines || []);
    return res.json({
      ok: true,
      order: payload,
      event: { id: String(eventDoc._id), slug: eventDoc.slug },
      attendanceSummary: attendance
    });
  } catch (err) {
    console.error('[admin] GET attendance error', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Internal error' });
  }
});

router.post('/events/:eventKey/orders/:orderId/attendance', async (req, res) => {
  try {
    const eventKey = String(req.params.eventKey || '').trim();
    const orderId = String(req.params.orderId || '').trim();
    const { lineIndex, sourceLineId, status, overrideSeatId, overrideZoneKey, note } = req.body || {};

    if (!eventKey || !orderId) {
      return res.status(400).json({ ok: false, error: 'eventKey and orderId are required' });
    }

    const eventDoc = await findEventByKey(eventKey);
    if (!eventDoc) {
      return res.status(404).json({ ok: false, error: 'Event not found' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }
    if (!orderMatchesEvent(order, eventDoc)) {
      return res.status(404).json({ ok: false, error: 'Order not linked to this event' });
    }

    const lines = Array.isArray(order.lines) ? order.lines : [];
    if (!lines.length) {
      return res.status(400).json({ ok: false, error: 'Order has no lines to update' });
    }

    let index = Number.isInteger(lineIndex) ? lineIndex : null;
    if (index === null && typeof lineIndex === 'string' && lineIndex !== '') {
      const parsed = Number(lineIndex);
      if (Number.isFinite(parsed)) index = parsed;
    }

    if (index === null && sourceLineId) {
      const sought = String(sourceLineId).trim();
      index = lines.findIndex(l => String(l?.sourceLineId || '') === sought);
    }

    if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
      return res.status(400).json({ ok: false, error: 'Invalid line selection' });
    }

    const cleanStatus = String(status || '').trim().toLowerCase();
    if (!['kept', 'released', 'moved'].includes(cleanStatus)) {
      return res.status(400).json({ ok: false, error: 'Invalid status' });
    }

    const seatOverride = String(overrideSeatId || '').trim();
    const zoneOverride = String(overrideZoneKey || '').trim().toUpperCase();
    const noteText = String(note || '').trim();

    if (cleanStatus === 'moved' && !seatOverride && !zoneOverride) {
      return res.status(400).json({ ok: false, error: 'Moved status requires a seat or zone override' });
    }

    const line = lines[index];
    const attendancePayload = applyAttendancePatch(line, {
      status: cleanStatus,
      overrideSeatId: seatOverride,
      overrideZoneKey: zoneOverride,
      note: noteText
    }, new Date(), 'admin-ui');

    order.lines[index].attendance = attendancePayload;
    order.markModified('lines');
    await order.save();

    const attendance = summarizeAttendance(order.lines || []);

    if (order.parentOrderId && cleanStatus === 'released') {
      await Order.updateOne(
        { _id: order.parentOrderId, 'lines.sourceLineId': line?.sourceLineId || null },
        {
          ...(line?.sourceLineId
            ? {
                $set: {
                  'lines.$.meta.lastReleasedEventId': String(eventDoc._id),
                  'lines.$.meta.lastReleasedAt': new Date(),
                  'lines.$.meta.lastReleasedReason': noteText || 'event_override'
                }
              }
            : {
                $set: {
                  'meta.lastReleasedEventId': String(eventDoc._id),
                  'meta.lastReleasedAt': new Date()
                }
              })
        }
      ).catch(err => {
        console.warn('[admin] parent order annot update failed', err?.message || err);
      });
    }

    const payload = normalizeAttendanceOrder(order.toObject());
    console.info('[admin] attendance update', {
      event: { id: String(eventDoc._id), slug: eventDoc.slug },
      orderId: String(order._id),
      parentOrderId: order.parentOrderId ? String(order.parentOrderId) : null,
      lineIndex: index,
      status: cleanStatus,
      overrideSeatId: seatOverride,
      overrideZoneKey: zoneOverride,
      operator: 'admin-ui'
    });
    return res.json({ ok: true, order: payload, attendanceSummary: attendance });
  } catch (err) {
    console.error('[admin] POST attendance error', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Internal error' });
  }
});

/* ===================== Script runner ===================== */
router.post('/scripts/:scriptId/run', async (req, res) => {
  const scriptId = (req.params.scriptId || '').toString();
  const found = getAdminScript(scriptId);
  if (!found?.script) {
    return res.status(404).json({ error: 'Unknown script' });
  }

  if (found.script?.automation?.taskId) {
    return res.status(400).json({ error: 'Script is managed via automation workflow.' });
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
    const returnUrl = extractReturnUrl(result.stdout);
    return res.json({
      ok: result.code === 0,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(returnUrl ? { returnUrl } : {})
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

router.post('/automation/scripts/:scriptId/jobs', async (req, res) => {
  const scriptId = (req.params.scriptId || '').toString();
  const found = getAdminScript(scriptId);
  const automationTaskId = found?.script?.automation?.taskId;
  if (!automationTaskId) {
    return res.status(404).json({ error: 'Automation script not found' });
  }

  if (found.script.danger) {
    const confirmToken = typeof req.body?.confirm === 'string' ? req.body.confirm.trim() : '';
    if (confirmToken !== found.script.id) {
      return res.status(400).json({
        error: 'Confirmation required',
        confirmToken: found.script.id
      });
    }
  }

  let task;
  try {
    task = ensureAutomationTask(automationTaskId);
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Automation task unavailable' });
  }

  const params = extractAutomationParams(req.body);
  const defaultDryRun = Boolean(found.script.automation?.defaultDryRun);
  const dryRun = req.body?.dryRun != null
    ? Boolean(req.body.dryRun)
    : req.body?.dry != null
      ? Boolean(req.body.dry)
      : defaultDryRun;

  if (dryRun && task.allowDryRun === false) {
    return res.status(400).json({ error: 'Dry-run not supported for this task.' });
  }

  try {
    if (typeof task.validateParams === 'function') {
      await Promise.resolve(task.validateParams(params, { dryRun }));
    }
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Invalid parameters.' });
  }

  try {
    const job = await createAutomationJob({
      scriptId: task.id,
      params,
      dryRun,
      version: task.version,
      requestedBy: 'admin-ui',
      requestContext: {
        integration: 'admin-ui',
        ip: req.ip,
        userAgent: req.get('user-agent') || null,
        metadata: req.body?.metadata || null
      }
    });

    const runMode = String(req.body?.runMode || '').toLowerCase();
    const sync = runMode === 'sync' || Boolean(req.body?.sync) || Boolean(req.body?.wait);

    if (sync) {
      const finished = await runAutomationJob(job);
      return res.status(201).json({ job: serializeAutomationJob(finished, { includeLogs: true }) });
    }

    runAutomationJobDetached(job._id).catch((error) => {
      console.error('[admin] automation job failed', job._id, error);
    });

    return res.status(202).json({ job: serializeAutomationJob(job) });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Unable to schedule job.' });
  }
});

router.get('/automation/scripts/:scriptId/jobs', async (req, res) => {
  const scriptId = (req.params.scriptId || '').toString();
  const found = getAdminScript(scriptId);
  const automationTaskId = found?.script?.automation?.taskId;
  if (!automationTaskId) {
    return res.status(404).json({ error: 'Automation script not found' });
  }

  try {
    const limitRaw = req.query.limit != null ? Number(req.query.limit) : undefined;
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
    const includeLogs =
      typeof req.query.logs === 'string' &&
      ['1', 'true', 'yes'].includes(req.query.logs.toLowerCase());
    const jobs = await listAutomationJobs({
      scriptId: automationTaskId,
      limit: limit ?? 20,
      status: req.query.status || undefined
    });
    return res.json({
      jobs: jobs.map(job => serializeAutomationJob(job, { includeLogs }))
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Unable to list jobs.' });
  }
});

router.get('/automation/jobs/:jobId', async (req, res) => {
  try {
    const job = await getAutomationJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }
    const includeLogs =
      typeof req.query.logs === 'string' &&
      ['1', 'true', 'yes'].includes(req.query.logs.toLowerCase());
    return res.json({
      job: serializeAutomationJob(job, { includeLogs })
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Unable to fetch job.' });
  }
});

router.get('/templates/download', (req, res) => {
  const rawPath = (req.query.path || '').toString();
  if (!rawPath) return res.status(400).send('Missing template path');
  try {
    const isCustomization = rawPath.startsWith('data/customization');
    const isDataTemplates = rawPath.startsWith('data/templates');
    const isDataAssets = rawPath.startsWith('data/assets');
    const isDataExamples = rawPath.startsWith('data_examples');
    const baseRoot = isCustomization
      ? CUSTOM_ROOT
      : isDataTemplates
        ? DATA_TEMPLATES_ROOT
        : isDataAssets
          ? DATA_ASSETS_ROOT
          : isDataExamples
            ? DATA_EXAMPLES_ROOT
            : TEMPLATES_ROOT;
    const relative = isCustomization
      ? rawPath.replace(/^data\/customization\/?/, '')
      : isDataTemplates
        ? rawPath.replace(/^data\/templates\/?/, '')
      : isDataAssets
        ? rawPath.replace(/^data\/assets\/?/, '')
      : isDataExamples
        ? rawPath.replace(/^data_examples\/?/, '')
      : rawPath
          .replace(/^data_references\/?/, '')
          .replace(/^data_templates\/?/, '')
          .replace(/^(?:scripts|data)\/templates\/?/, '');
    const abs = resolveInside(baseRoot, relative);
    const filename = path.basename(abs);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).send('Template not found');
    }
    res.attachment(filename);
    return res.sendFile(abs, { dotfiles: 'allow' }, (err) => {
      if (err) {
        console.error('[admin] template download error:', err?.message || err);
        if (!res.headersSent) res.status(err.statusCode || 500).send('Unable to download template');
      }
    });
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

router.post('/outputs/delete', (req, res) => {
  const raw = (req.body?.file || '').toString();
  if (!raw) return res.status(400).json({ ok: false, error: 'Missing file' });
  try {
    const abs = resolveInside(OUTPUTS_ROOT, raw);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ ok: false, error: 'File not found' });
    }
    fs.unlinkSync(abs);
    return res.json({ ok: true });
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid output file' });
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

router.post('/inputs/delete', (req, res) => {
  const raw = (req.body?.file || '').toString();
  if (!raw) return res.status(400).json({ ok: false, error: 'Missing file' });
  try {
    const abs = resolveInside(INPUTS_ROOT, raw);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ ok: false, error: 'File not found' });
    }
    fs.unlinkSync(abs);
    return res.json({ ok: true });
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid input file' });
  }
});

router.post('/uploads', (req, res) => {
  const { filename, contentBase64, subdir } = req.body || {};
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
  let destDir = INPUTS_ROOT;
  if (subdir) {
    try {
      const cleaned = String(subdir).replace(/^\/+/, '');
      destDir = resolveInside(INPUTS_ROOT, cleaned);
      fs.mkdirSync(destDir, { recursive: true });
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid subdir' });
    }
  }
  const dest = path.join(destDir, safeName);
  try {
    fs.writeFileSync(dest, buffer);
    const relPath = path.relative(INPUTS_ROOT, dest).replace(/\\/g, '/');
    return res.json({ ok: true, filename: safeName, path: `data/inputs/${relPath}`, size: buffer.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'Unable to store file' });
  }
});

router.post('/templates/upload', (req, res) => {
  return res.status(403).json({ ok: false, error: 'Uploads are restricted to data/inputs.' });
});

router.post('/customization/upload', (req, res) => {
  return res.status(403).json({ ok: false, error: 'Uploads are restricted to data/inputs.' });
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
    {
      $match: {
        seasonCode,
        venueSlug,
        phase: 'subscription', // vue stats zones: ne compte que les abonnements
        ...statusMatch,
        'lines.zoneKey': { $in: zoneKeys }
      }
    },
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
registerDefaultAutomationTasks();
