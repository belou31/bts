#!/usr/bin/env node
/**
 * Copy the partner templates (one per connection kind) to
 * data/customization/partners/_templates/<kind>.json, where they can be
 * adapted to this installation (labels, entitlements, payment mode…).
 *
 * Usage:
 *   node scripts/05-partner-management/init-partners.js [--force]
 *
 * Kinds: openid, directory, none. Source: data_references/partners/<kind>.json.
 * An existing local template is kept unless --force is passed.
 *
 * Templates are copied into a partner's file once, at creation
 * (upsert-partner.js --template=<kind>); editing a template later does not
 * change existing partners.
 */

import fs from 'fs';
import path from 'path';
import process from 'process';
import { PARTNER_TEMPLATES, builtinTemplatePath, localTemplatePath } from '../../src/config/partners.js';

const FORCE = process.argv.slice(2).includes('--force');

for (const kind of PARTNER_TEMPLATES) {
  const from = builtinTemplatePath(kind);
  const to = localTemplatePath(kind);
  if (!fs.existsSync(from)) {
    console.error(`[partners:init] missing built-in template ${from}`);
    process.exitCode = 1;
    continue;
  }
  if (fs.existsSync(to) && !FORCE) {
    console.log(`[partners:init] kept    ${to} (exists; --force to overwrite)`);
    continue;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`[partners:init] written ${to}`);
}
console.log('Create a partner from one of them: upsert-partner.js --slug=<slug> --name="…" --template=openid|directory|none');
