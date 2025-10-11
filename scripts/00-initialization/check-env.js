/**
 * Validate environment configuration
 *
 * Checks core .env variables for internal consistency (APP_URL, BASE_PATH, HelloAsso).
 *
 * Usage:
 *   node scripts/00-initialization/check-env.js
 *
 * Environment:
 *   - APP_ENV, APP_URL, BASE_PATH, HELLOASSO_* variables
 *
 * Template:
 */
import url from 'node:url';

import dotenv from 'dotenv';
dotenv.config();


function ok(name, cond, fix='') {
  if (cond) console.log(`✅ ${name}`);
  else { console.error(`❌ ${name}${fix ? ' → ' + fix : ''}`); process.exitCode = 1; }
}

const { APP_ENV, APP_URL, BASE_PATH, HELLOASSO_RETURN_URL, HELLOASSO_STUB, HELLOASSO_API_URL } = process.env;

ok('APP_ENV défini', !!APP_ENV);
ok('APP_URL valide', (()=>{ try { new URL(APP_URL); return true; } catch { return false; } })(), 'ex: http://localhost:8080 ou https://.../bts');

const isDev = (APP_ENV === 'development');
ok('BASE_PATH cohérent', isDev ? (BASE_PATH === '' || BASE_PATH == null) : (BASE_PATH === '/bts'),
   isDev ? 'DEV: BASE_PATH vide' : 'INT/PROD: BASE_PATH=/bts');

ok('HELLOASSO_RETURN_URL cohérente', (()=> {
  try {
    const u = new URL(HELLOASSO_RETURN_URL);
    if (isDev) return !u.pathname.startsWith('/bts/');
    return u.pathname.startsWith('/bts/');
  } catch { return false; }
})(), isDev ? 'DEV: pas de /bts dans le path' : 'INT/PROD: path doit commencer par /bts/');

ok('HELLOASSO mode', isDev ? (HELLOASSO_STUB === 'true') : (HELLOASSO_STUB === 'false'),
   isDev ? 'DEV: HELLOASSO_STUB=true' : 'INT/PROD: HELLOASSO_STUB=false');

ok('HELLOASSO_API_URL cohérente', isDev ? (HELLOASSO_API_URL === '' || !HELLOASSO_API_URL)
                                        : !!HELLOASSO_API_URL,
   isDev ? 'DEV: vide (stub)' : 'INT: sandbox / PROD: production');

// Bonus: warns utiles
function warn(name, cond, msg){ if(!cond) console.warn(`⚠️  ${name}: ${msg}`); }
warn('APP_URL vs BASE_PATH', (()=> {
  if (!APP_URL) return true;
  try {
    const u = new URL(APP_URL);
    if (isDev) return !u.pathname.startsWith('/bts');
    return u.pathname.startsWith('/bts');
  } catch { return true; }
})(), isDev ? 'DEV: APP_URL ne doit pas contenir /bts'
            : 'INT/PROD: APP_URL doit inclure /bts (ex: https://…/bts)');
