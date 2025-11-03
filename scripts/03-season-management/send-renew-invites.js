#!/usr/bin/env node
import 'dotenv/config';
import mongoose from 'mongoose';

import { connectDB } from '../../src/loaders/mongoose.js';
import {
  registerDefaultAutomationTasks,
  createJob,
  runJob
} from '../../src/services/automation/index.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (const token of argv.slice(2)) {
    if (!token) continue;
    if (token.startsWith('--')) {
      const trimmed = token.slice(2);
      if (!trimmed) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex >= 0) {
        const key = trimmed.slice(0, eqIndex);
        const value = trimmed.slice(eqIndex + 1);
        args[key] = value;
      } else {
        args[trimmed] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized);
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main() {
  const args = parseArgs(process.argv);

  const csv =
    args.csv ||
    args.file ||
    args._[0] ||
    'renew-groups.csv';

  if (!csv) {
    console.error('❌ CSV path required (argument or --csv=path).');
    process.exit(1);
  }

  const dryRun = toBoolean(
    args.dry ?? args['dry-run'] ?? args.dryRun,
    false
  );

  registerDefaultAutomationTasks();
  await connectDB();

  const params = {
    csv,
    subject: args.subject || args.subj,
    limit: toNumber(args.limit, undefined),
    offset: toNumber(args.offset, undefined),
    delayMs: toNumber(args.delay ?? args.delayMs, undefined),
    separator: args.sep || args.separator,
    template: args.template || args.templateName,
    seasonCode: args.season || args.seasonCode,
    clubName: args.club || args.clubName,
    deadline: args.deadline || args.limitDate || args.deadlineDate,
    venue: args.venue || args.venueSlug,
    fromName: args.from || args.fromName,
    providerLabel: args.provider || args.providerLabel
  };

  const requestedBy =
    args.requestedBy ||
    process.env.USER ||
    process.env.LOGNAME ||
    'cli';

  const job = await createJob({
    scriptId: 'season.send-renew-invites',
    params,
    dryRun,
    requestedBy,
    requestContext: {
      integration: 'cli',
      userAgent: 'scripts/send-renew-invites'
    }
  });

  const result = await runJob(job);

  if (result.status === 'succeeded') {
    const summary = result.result?.summary || 'Job completed successfully.';
    console.log(`✅ ${summary}`);
    if (result.result?.payload) {
      console.log(JSON.stringify(result.result.payload, null, 2));
    }
    await mongoose.disconnect();
    process.exit(0);
  }

  console.error('❌ Job failed.');
  if (result.error) {
    console.error(result.error.message);
    if (result.error.stack) console.error(result.error.stack);
    if (result.error.details) console.error(JSON.stringify(result.error.details, null, 2));
  }
  if (Array.isArray(result.logs) && result.logs.length > 0) {
    console.error('Logs:');
    for (const log of result.logs.slice(-10)) {
      const level = log.level?.toUpperCase() || 'INFO';
      console.error(`  [${level}] ${log.message}`);
    }
  }

  await mongoose.disconnect();
  process.exit(1);
}

main().catch(async (error) => {
  console.error('❌ Unexpected error:', error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});

