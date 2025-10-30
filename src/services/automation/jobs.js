// src/services/automation/jobs.js
import mongoose from 'mongoose';

import { AutomationJob } from '../../models/AutomationJob.js';
import { createJobLogger } from './logger.js';
import { createExecutionContext } from './context.js';
import { ensureTask } from './registry.js';

function asPlainObject(doc) {
  if (!doc) return null;
  if (typeof doc.toObject === 'function') return doc.toObject();
  return JSON.parse(JSON.stringify(doc));
}

export async function createJob({
  scriptId,
  params = {},
  dryRun = false,
  requestedBy,
  requestContext = {},
  version
}) {
  const payload = {
    scriptId,
    params,
    dryRun: Boolean(dryRun),
    requestedBy: requestedBy || null,
    requestContext,
    version
  };
  const job = await AutomationJob.create(payload);
  return job;
}

export async function runJob(job, { skipValidation = false } = {}) {
  if (!job) throw new Error('Job document required');
  const jobDoc = job instanceof AutomationJob ? job : await AutomationJob.findById(job);
  if (!jobDoc) throw new Error('Job not found');

  const resolvedTask = ensureTask(jobDoc.scriptId);

  const logger = createJobLogger(jobDoc);

  jobDoc.markRunning();
  jobDoc.appendLog({ level: 'info', message: `Starting task "${resolvedTask.id}"` });
  await jobDoc.save();

  const context = createExecutionContext({
    job: jobDoc,
    logger,
    dryRun: Boolean(jobDoc.dryRun),
    task: resolvedTask
  });

  try {
    if (!skipValidation && resolvedTask.validateParams) {
      await Promise.resolve(resolvedTask.validateParams(jobDoc.params || {}, context));
    }
    const output = await Promise.resolve(
      resolvedTask.handler(jobDoc.params || {}, context)
    );
    const payload = output && typeof output === 'object' ? output : { summary: String(output || '') };
    jobDoc.markDone('succeeded', payload);
  } catch (error) {
    logger.error(error?.message || 'Task failed', {
      stack: error?.stack,
      code: error?.code
    });
    jobDoc.markDone('failed', {
      message: error?.message || 'Task failed',
      stack: error?.stack,
      details: error?.details || null
    });
  }

  await jobDoc.save();
  return jobDoc;
}

export function runJobDetached(jobId, options = {}) {
  return new Promise((resolve, reject) => {
    setImmediate(async () => {
      try {
        const jobDoc = await runJob(jobId, options);
        resolve(jobDoc);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function listJobs({ scriptId, limit = 20, status } = {}) {
  const filters = {};
  if (scriptId) filters.scriptId = scriptId;
  if (status) filters.status = status;
  const query = AutomationJob.find(filters)
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 200));
  return query.exec();
}

export async function getJob(jobId) {
  if (!jobId) return null;
  if (jobId instanceof AutomationJob) return jobId;
  if (jobId instanceof mongoose.Types.ObjectId) {
    return AutomationJob.findById(jobId).exec();
  }
  return AutomationJob.findById(String(jobId)).exec();
}

export async function appendJobLog(jobId, entry) {
  const jobDoc = await getJob(jobId);
  if (!jobDoc) {
    throw new Error('Job not found');
  }
  jobDoc.appendLog(entry);
  await jobDoc.save();
  return asPlainObject(jobDoc);
}
