// src/services/automation/context.js
import fs from 'node:fs';
import path from 'node:path';

import * as models from '../../models/index.js';
import { resolveOrganizationName } from '../customization.js';

const ROOT_DIR = process.cwd();
const DATA_DIR = path.resolve(ROOT_DIR, 'data');
const INPUTS_DIR = path.resolve(DATA_DIR, 'inputs');
const OUTPUTS_DIR = path.resolve(DATA_DIR, 'outputs');
const TEMPLATES_DIR = path.resolve(DATA_DIR, 'templates');

for (const dir of [DATA_DIR, INPUTS_DIR, OUTPUTS_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[automation] Unable to ensure directory', dir, error?.message);
  }
}

const SAFE_BASES = {
  data: DATA_DIR,
  inputs: INPUTS_DIR,
  outputs: OUTPUTS_DIR,
  templates: TEMPLATES_DIR
};

function resolveInside(baseDir, candidate) {
  if (!candidate) throw new Error('Path is required');
  const normalized = String(candidate).replace(/^\/+/, '');
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, normalized);
  if (!target.startsWith(resolvedBase)) {
    throw new Error('Forbidden path');
  }
  return target;
}

function ensureParentDir(targetPath) {
  const parent = path.dirname(targetPath);
  fs.mkdirSync(parent, { recursive: true });
}

/**
 * Creates the execution context handed to automation tasks when they run.
 * Includes access to Mongoose models, helper path resolvers, and runtime metadata.
 */
export function createExecutionContext({ job, logger, dryRun = false, task } = {}) {
  const resolveDataPath = (kind, relativePath, { ensureDir = false } = {}) => {
    if (!SAFE_BASES[kind]) {
      throw new Error(`Unknown data path kind "${kind}"`);
    }
    const absolutePath = resolveInside(SAFE_BASES[kind], relativePath || '');
    if (ensureDir) {
      ensureParentDir(absolutePath);
    }
    return absolutePath;
  };

  return {
    job,
    task,
    dryRun,
    logger,
    models,
    env: {
      clubName: resolveOrganizationName(),
      appEnv: process.env.APP_ENV || '',
      basePath: process.env.BASE_PATH || '',
      host: process.env.HOST || ''
    },
    paths: {
      root: ROOT_DIR,
      data: DATA_DIR,
      inputs: INPUTS_DIR,
      outputs: OUTPUTS_DIR,
      templates: TEMPLATES_DIR,
      resolve: resolveDataPath
    },
    fs: {
      exists: fs.existsSync,
      readFile: fs.promises.readFile,
      writeFile: fs.promises.writeFile,
      mkdir: fs.promises.mkdir,
      ensureDir: (relativeDir, kind = 'outputs') => {
        const dirPath = resolveDataPath(kind, relativeDir || '');
        fs.mkdirSync(dirPath, { recursive: true });
        return dirPath;
      }
    }
  };
}

