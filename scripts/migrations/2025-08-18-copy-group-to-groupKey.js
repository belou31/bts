/**
 * Copie l'ancien champ "group" vers "groupKey" si groupKey est vide.
 * Usage :
 *   APP_ENV=development node scripts/migrations/2025-08-18-copy-group-to-groupKey.js
 *   APP_ENV=integration node scripts/migrations/2025-08-18-copy-group-to-groupKey.js
 *   APP_ENV=production  node scripts/migrations/2025-08-18-copy-group-to-groupKey.js
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const env = (process.env.APP_ENV || 'development').toLowerCase();
  const candidates = [process.env.DOTENV_PATH, `.env.${env}`, env==='development'?'.env.dev':null, '.env'].filter(Boolean);
  for (const p of candidates) {
    const abs = path.resolve(process.cwd(), p);
    if (fs.existsSync(abs)) { require('dotenv').config({ path: abs }); console.log(`[group→groupKey] Loaded env: ${p}`); return; }
  }
  require('dotenv').config();
}
loadEnv();

const mongoose = require('mongoose');
const Subscriber = require('../../src/models/Subscriber');

function normGroupKey(v) {
  const s = String(v || '').trim().toLowerCase();
  return s ? s.replace(/\s+/g, '_') : null;
}

(async () => {
  const env = (process.env.APP_ENV || 'development').toLowerCase();
  const mongoUri =
    env === 'production'  ? process.env.MONGO_URI_PROD :
    env === 'integration' ? process.env.MONGO_URI_INT  :
    (process.env.MONGO_URI_DEV || process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bts');

  await mongoose.connect(mongoUri);

  let scanned = 0, updated = 0;
  const cur = Subscriber.find({}, { _id:1, group:1, groupKey:1 }).cursor();
  for await (const s of cur) {
    scanned++;
    if (!s.groupKey && s.group) {
      const gk = normGroupKey(s.group);
      await Subscriber.updateOne({ _id: s._id }, { $set: { groupKey: gk } });
      updated++;
    }
  }
  console.log(`[group→groupKey] scanned=${scanned} updated=${updated}`);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('[group→groupKey] ERROR', e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
