// src/routes/automation/index.js
import express from 'express';
import rateLimit from 'express-rate-limit';

import {
  automationAuth,
  requireAnyScope,
  hasAnyScope
} from '../../middlewares/automation-auth.js';
import {
  registerDefaultAutomationTasks,
  listTasks,
  ensureTask,
  createJob,
  runJob,
  runJobDetached,
  listJobs,
  getJob
} from '../../services/automation/index.js';
import {
  serializeTask,
  serializeJob,
  serializeLogEntry
} from '../../services/automation/serializers.js';

registerDefaultAutomationTasks();

const router = express.Router();

const WINDOW_MS = Number(process.env.AUTOMATION_RATE_WINDOW_MS || 60_000);
const MAX_REQUESTS = Number(process.env.AUTOMATION_RATE_LIMIT || 30);

const limiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.automationAuth?.subject ||
    req.automationAuth?.integration ||
    req.ip
});

const RESERVED_PAYLOAD_KEYS = new Set([
  'dryRun',
  'runMode',
  'execute',
  'sync',
  'wait',
  'params',
  'metadata'
]);

function normalizeDryRunFlag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'y', 'on', 'dry'].includes(normalized);
}

function extractParams(body = {}) {
  if (!body || typeof body !== 'object') return {};
  const params = {};
  if (body.params && typeof body.params === 'object') {
    Object.assign(params, body.params);
  }
  for (const [key, value] of Object.entries(body)) {
    if (!RESERVED_PAYLOAD_KEYS.has(key)) {
      params[key] = value;
    }
  }
  return params;
}

router.use(automationAuth);
router.use(limiter);

router.get(
  '/scripts',
  requireAnyScope(['automation:scripts:read', 'automation:jobs:read']),
  (req, res) => {
    const scripts = listTasks().map(serializeTask);
    return res.json({ scripts });
  }
);

router.get(
  '/scripts/:id',
  requireAnyScope(['automation:scripts:read', 'automation:jobs:read']),
  (req, res) => {
    try {
      const task = ensureTask(req.params.id);
      return res.json({ script: serializeTask(task) });
    } catch (error) {
      return res.status(404).json({ error: 'Unknown automation script.' });
    }
  }
);

router.post(
  '/scripts/:id/jobs',
  requireAnyScope(['automation:jobs:write', 'automation:jobs:run']),
  async (req, res, next) => {
    let task;
    try {
      task = ensureTask(req.params.id);
    } catch (error) {
      return res.status(404).json({ error: 'Unknown automation script.' });
    }

    if (task.scopes && task.scopes.length > 0 && !hasAnyScope(req.automationAuth, task.scopes)) {
      return res.status(403).json({ error: 'Forbidden: missing task scope.' });
    }

    const params = extractParams(req.body);
    const dryRun = normalizeDryRunFlag(
      req.body?.dryRun ?? req.body?.dry,
      false
    );
    if (dryRun && task.allowDryRun === false) {
      return res.status(400).json({ error: 'Dry-run not supported for this task.' });
    }

    try {
      if (typeof task.validateParams === 'function') {
        await Promise.resolve(task.validateParams(params, { dryRun }));
      }
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Invalid parameters.' });
    }

    try {
      const job = await createJob({
        scriptId: task.id,
        params,
        dryRun,
        version: task.version,
        requestedBy: req.automationAuth?.requestedBy || req.automationAuth?.subject || null,
        requestContext: {
          ip: req.automationAuth?.ip || req.ip,
          userAgent: req.get('user-agent') || null,
          integration: req.automationAuth?.integration || null,
          metadata: req.body?.metadata || null
        }
      });

      const runMode = String(req.body?.runMode || req.body?.execute || '').toLowerCase();
      const wait = normalizeDryRunFlag(req.body?.wait) || normalizeDryRunFlag(req.body?.sync);
      const runSynchronously = runMode === 'sync' || wait;

      if (runSynchronously) {
        const finished = await runJob(job);
        return res.status(201).json({ job: serializeJob(finished, { includeLogs: true }) });
      }

      runJobDetached(job._id).catch((error) => {
        // eslint-disable-next-line no-console
        console.error(`[automation] background job failed (${job._id}):`, error);
      });

      return res
        .status(202)
        .json({ job: serializeJob(job, { includeLogs: false }) });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  '/jobs',
  requireAnyScope(['automation:jobs:read']),
  async (req, res, next) => {
    try {
      const filters = {
        scriptId: req.query.scriptId || undefined,
        status: req.query.status || undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined
      };
      const jobs = await listJobs(filters);
      const includeLogs = normalizeDryRunFlag(req.query.logs);
      return res.json({
        jobs: jobs.map((job) => serializeJob(job, { includeLogs }))
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  '/jobs/:jobId',
  requireAnyScope(['automation:jobs:read']),
  async (req, res, next) => {
    try {
      const job = await getJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
      }
      const includeLogs = normalizeDryRunFlag(req.query.logs);
      return res.json({ job: serializeJob(job, { includeLogs }) });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  '/jobs/:jobId/logs',
  requireAnyScope(['automation:jobs:read']),
  async (req, res, next) => {
    try {
      const job = await getJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
      }
      const logs = Array.isArray(job.logs) ? job.logs.map(serializeLogEntry) : [];
      return res.json({ logs });
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
