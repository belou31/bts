// src/services/automation/registry.js
import crypto from 'node:crypto';

const registry = new Map();

function validateTaskDefinition(definition = {}) {
  if (!definition.id) {
    throw new Error('Task definition requires an "id"');
  }
  if (typeof definition.handler !== 'function') {
    throw new Error(`Task "${definition.id}" requires a "handler" function`);
  }
  const scopes = Array.isArray(definition.scopes)
    ? [...new Set(definition.scopes.map(String))]
    : [];

  return {
    id: String(definition.id),
    version: definition.version ? String(definition.version) : undefined,
    summary: definition.summary || '',
    description: definition.description || '',
    handler: definition.handler,
    validateParams: typeof definition.validateParams === 'function' ? definition.validateParams : null,
    schema: definition.schema || null,
    tags: Array.isArray(definition.tags) ? [...new Set(definition.tags.map(String))] : [],
    allowDryRun: definition.allowDryRun !== false,
    scopes,
    linkedScriptId: definition.linkedScriptId || null,
    metadata: definition.metadata || {}
  };
}

export function registerTask(definition) {
  const validated = validateTaskDefinition(definition);
  const existing = registry.get(validated.id);
  if (existing) {
    // eslint-disable-next-line no-console
    console.warn(`[automation] Overriding task registration "${validated.id}"`);
  }
  registry.set(validated.id, Object.freeze(validated));
  return registry.get(validated.id);
}

export function listTasks() {
  return Array.from(registry.values());
}

export function getTask(taskId) {
  if (!taskId) return null;
  return registry.get(taskId);
}

export function hasTask(taskId) {
  return registry.has(taskId);
}

export function ensureTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error(`Unknown automation task "${taskId}"`);
  return task;
}

export function taskSignature(taskId) {
  const task = ensureTask(taskId);
  const basis = JSON.stringify({
    id: task.id,
    version: task.version || '0',
    schema: task.schema || null
  });
  return crypto.createHash('sha256').update(basis).digest('hex');
}

export function clearRegistry() {
  registry.clear();
}
