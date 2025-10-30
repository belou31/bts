// src/services/automation/logger.js
const MAX_LOG_ENTRIES = 500;

const LEVEL_TO_CONSOLE = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error'
};

function normaliseLevel(level) {
  if (!level) return 'info';
  const lower = String(level).toLowerCase();
  return LEVEL_TO_CONSOLE[lower] ? lower : 'info';
}

function asPlainObject(data) {
  if (data == null) return null;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return String(data);
  }
}

export function createJobLogger(jobDoc) {
  if (!jobDoc) {
    throw new Error('Job logger requires a job document');
  }
  const prefix = `[automation:${jobDoc.scriptId}#${jobDoc.id || jobDoc._id}]`;

  const append = (level, message, data) => {
    const logLevel = normaliseLevel(level);
    const entry = jobDoc.appendLog({
      level: logLevel,
      message: message ?? '',
      data: asPlainObject(data)
    });
    if (jobDoc.logs.length > MAX_LOG_ENTRIES) {
      jobDoc.logs = jobDoc.logs.slice(jobDoc.logs.length - MAX_LOG_ENTRIES);
    }
    const consoleMethod = LEVEL_TO_CONSOLE[logLevel] || 'log';
    try {
      if (data !== undefined) {
        // eslint-disable-next-line no-console
        console[consoleMethod](`${prefix} ${entry.message}`, data);
      } else {
        // eslint-disable-next-line no-console
        console[consoleMethod](`${prefix} ${entry.message}`);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`${prefix} failed to log`, error);
    }
    return entry;
  };

  return {
    debug: (message, data) => append('debug', message, data),
    info: (message, data) => append('info', message, data),
    warn: (message, data) => append('warn', message, data),
    error: (message, data) => append('error', message, data),
    fatal: (message, data) => append('error', message, data),
    snapshot: () => jobDoc.logs.slice(),
    append
  };
}

