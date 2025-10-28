// src/models/AutomationJob.js
import mongoose from 'mongoose';

const { Schema } = mongoose;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const STATUSES = ['queued', 'running', 'succeeded', 'failed'];

const jobLogSchema = new Schema(
  {
    at: { type: Date, default: () => new Date() },
    level: { type: String, enum: LOG_LEVELS, default: 'info' },
    message: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: null }
  },
  { _id: false }
);

const requestContextSchema = new Schema(
  {
    ip: { type: String },
    userAgent: { type: String },
    integration: { type: String },
    metadata: { type: Schema.Types.Mixed, default: undefined }
  },
  { _id: false }
);

const jobResultSchema = new Schema(
  {
    summary: { type: String },
    payload: { type: Schema.Types.Mixed, default: null }
  },
  { _id: false }
);

const jobErrorSchema = new Schema(
  {
    message: { type: String, required: true },
    stack: { type: String },
    details: { type: Schema.Types.Mixed }
  },
  { _id: false }
);

const automationJobSchema = new Schema(
  {
    scriptId: { type: String, required: true, index: true },
    version: { type: String },
    status: { type: String, enum: STATUSES, default: 'queued', index: true },
    dryRun: { type: Boolean, default: false },
    params: { type: Schema.Types.Mixed, default: () => ({}) },
    requestedBy: { type: String },
    requestContext: { type: requestContextSchema, default: undefined },
    logs: { type: [jobLogSchema], default: [] },
    result: { type: jobResultSchema, default: undefined },
    error: { type: jobErrorSchema, default: undefined },
    startedAt: { type: Date },
    finishedAt: { type: Date }
  },
  {
    timestamps: true
  }
);

automationJobSchema.index({ createdAt: -1 });

automationJobSchema.methods.appendLog = function appendLog(entry) {
  const MAX_LOG_ENTRIES = 500;
  const logEntry = {
    at: entry?.at || new Date(),
    level: LOG_LEVELS.includes(entry?.level) ? entry.level : 'info',
    message: String(entry?.message || '').slice(0, 2000),
    data: entry?.data
  };
  this.logs.push(logEntry);
  if (this.logs.length > MAX_LOG_ENTRIES) {
    this.logs = this.logs.slice(this.logs.length - MAX_LOG_ENTRIES);
  }
  return logEntry;
};

automationJobSchema.methods.markRunning = function markRunning() {
  this.status = 'running';
  this.startedAt = new Date();
};

automationJobSchema.methods.markDone = function markDone(status, payload = {}) {
  this.status = status;
  this.finishedAt = new Date();
  if (status === 'succeeded') {
    this.result = {
      summary: payload?.summary,
      payload: payload?.payload ?? null
    };
    this.error = undefined;
  } else if (status === 'failed') {
    this.error = {
      message: payload?.message || 'Job failed',
      stack: payload?.stack,
      details: payload?.details
    };
  }
};

export const AutomationJob =
  mongoose.models.AutomationJob || mongoose.model('AutomationJob', automationJobSchema);
