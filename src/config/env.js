// src/config/env.js
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';

function loadEnv() {
  const appEnv = (process.env.APP_ENV || 'development').toLowerCase();
  const candidates = {
    development: '.env.dev',
    integration: '.env.int',
    production:  '.env.prod'
  };
  const p = path.join(process.cwd(), candidates[appEnv] || '.env');
  if (fs.existsSync(p)) {
    require('dotenv').config({ path: p });
    console.log(`[BTS] Loaded env file: ${path.basename(p)} (APP_ENV=${appEnv})`);
  } else {
    require('dotenv').config(); // fallback .env
    console.log(`[BTS] Loaded default .env (APP_ENV=${appEnv})`);
  }
}
export default loadEnv;
