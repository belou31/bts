#!/usr/bin/env node
/**
 * Purge operational logs from MongoDB.
 *
 * - Deletes ScanLog documents (ticket scan logs).
 * - Clears embedded logs on AutomationJob documents.
 *
 * Usage:
 *   node scripts/00-system-management/purge-logs.js --apply
 *
 * Flags:
 *   --apply     Actually perform deletions. Without it, runs in dry-run mode.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import { ScanLog } from '../../src/models/ScanLog.js';
import { AutomationJob } from '../../src/models/AutomationJob.js';

dotenv.config();

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('Missing MONGO_URI in environment (.env)');
  process.exit(1);
}

const apply = process.argv.includes('--apply');

async function run() {
  await mongoose.connect(uri);

  const scanLogCount = await ScanLog.countDocuments();
  const jobsWithLogs = await AutomationJob.countDocuments({ 'logs.0': { $exists: true } });

  console.log(`Scan logs: ${scanLogCount}`);
  console.log(`Automation jobs with logs: ${jobsWithLogs}`);

  if (!apply) {
    console.log('Dry-run (no changes). Add --apply to purge logs.');
    return;
  }

  const scanResult = await ScanLog.deleteMany({});
  const jobResult = await AutomationJob.updateMany(
    { 'logs.0': { $exists: true } },
    { $set: { logs: [] } }
  );

  console.log(`✓ Removed ${scanResult.deletedCount || 0} scan log(s).`);
  console.log(`✓ Cleared logs on ${jobResult.modifiedCount || 0} automation job(s).`);
}

run()
  .catch((err) => {
    console.error('Purge failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
