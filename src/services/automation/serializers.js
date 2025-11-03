// src/services/automation/serializers.js
import { taskSignature } from './registry.js';

function toIso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

export function serializeTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    version: task.version || null,
    summary: task.summary || '',
    description: task.description || '',
    tags: task.tags || [],
    allowDryRun: Boolean(task.allowDryRun),
    scopes: task.scopes || [],
    schema: task.schema || null,
    signature: taskSignature(task.id),
    metadata: task.metadata || {}
  };
}

export function serializeLogEntry(entry) {
  if (!entry) return null;
  return {
    at: toIso(entry.at),
    level: entry.level || 'info',
    message: entry.message || '',
    data: entry.data ?? null
  };
}

export function serializeJob(job, { includeLogs = false } = {}) {
  if (!job) return null;
  const plain = typeof job.toObject === 'function' ? job.toObject() : { ...job };
  const response = {
    id: String(plain._id || plain.id || ''),
    scriptId: plain.scriptId,
    version: plain.version || null,
    status: plain.status,
    dryRun: Boolean(plain.dryRun),
    params: plain.params || {},
    requestedBy: plain.requestedBy || null,
    requestContext: plain.requestContext || null,
    result: plain.result || null,
    error: plain.error || null,
    createdAt: toIso(plain.createdAt),
    updatedAt: toIso(plain.updatedAt),
    startedAt: toIso(plain.startedAt),
    finishedAt: toIso(plain.finishedAt)
  };

  if (includeLogs && Array.isArray(plain.logs)) {
    response.logs = plain.logs.map(serializeLogEntry);
  }

  return response;
}

