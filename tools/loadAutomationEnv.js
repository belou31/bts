'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let dotenv;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  dotenv = require('dotenv');
} catch (err) {
  console.warn('[loadAutomationEnv] dotenv module not available; skipping shared secret load.');
  module.exports = undefined;
  return;
}

const seen = new Set();

function candidatePaths() {
  const inputs = [];
  if (process.env.BTS_AUTOMATION_ENV) {
    inputs.push(process.env.BTS_AUTOMATION_ENV);
  }
  inputs.push(path.join(os.homedir(), '.config', 'bts', 'automation.env'));
  return inputs
    .map((p) => path.resolve(p))
    .filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return fs.existsSync(p) && fs.statSync(p).isFile();
    });
}

function loadAutomationEnv() {
  const paths = candidatePaths();
  if (!paths.length) {
    return null;
  }
  let loaded = null;
  for (const p of paths) {
    const result = dotenv.config({ path: p, override: false });
    if (result.error) {
      console.warn(`[loadAutomationEnv] Failed to load ${p}: ${result.error.message}`);
      continue;
    }
    loaded = p;
  }
  if (!loaded) {
    return null;
  }
  if (!process.env.BTS_AUTOMATION_ENV_LOADED) {
    process.env.BTS_AUTOMATION_ENV_LOADED = loaded;
  }
  return loaded;
}

const loadedPath = loadAutomationEnv();
if (loadedPath) {
  console.debug(`[loadAutomationEnv] Loaded shared automation env: ${loadedPath}`);
}

module.exports = { loadAutomationEnv };
