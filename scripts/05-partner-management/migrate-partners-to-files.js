#!/usr/bin/env node
/**
 * Split the former data/customization/partners.json (one array for all
 * partners) into one file per partner:
 *
 *   data/customization/partners/<slug>/partner.json
 *
 * Usage:
 *   node scripts/05-partner-management/migrate-partners-to-files.js [--dry-run]
 *
 * - Each entry is written as is (same keys, same values).
 * - A partner that already has its own file is not overwritten: its entry in
 *   partners.json is reported and left out.
 * - Before any write, the original is copied to partners.json.migrated-<date>
 *   (backup, never read). Once every entry is migrated, partners.json is
 *   removed.
 * - An unreadable partners.json stops the script before any write.
 */

import fs from 'fs';
import process from 'process';
import {
  legacyPartnersFile, partnerConfigPath, writePartnerConfig, normalizeSlug
} from '../../src/config/partners.js';

const DRY_RUN = process.argv.slice(2).includes('--dry-run');
const legacy = legacyPartnersFile();

if (!fs.existsSync(legacy)) {
  console.log(`Nothing to migrate: ${legacy} does not exist.`);
  process.exit(0);
}

let entries;
try {
  entries = JSON.parse(fs.readFileSync(legacy, 'utf8'));
} catch (err) {
  console.error(`❌ ${legacy} is not valid JSON, nothing written: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(entries)) {
  console.error(`❌ ${legacy}: an array of partners is expected, nothing written.`);
  process.exit(1);
}

// Sauvegarde de l'original complet avant toute écriture : chaque partenaire
// migré est retiré du tableau au passage (writePartnerConfig).
const backup = `${legacy}.migrated-${new Date().toISOString().slice(0, 10)}`;
if (!DRY_RUN) fs.copyFileSync(legacy, backup);

let written = 0;
let skipped = 0;
const seen = new Set();
for (const entry of entries) {
  const slug = normalizeSlug(entry?.slug);
  if (!slug) {
    console.warn('⚠ entry without slug, left out');
    skipped++;
    continue;
  }
  if (seen.has(slug)) {
    console.warn(`⚠ "${slug}" appears twice in partners.json: only the first entry is migrated`);
    skipped++;
    continue;
  }
  seen.add(slug);
  const target = partnerConfigPath(slug);
  if (fs.existsSync(target)) {
    console.warn(`⚠ "${slug}": ${target} already exists, not overwritten`);
    skipped++;
    continue;
  }
  if (DRY_RUN) {
    console.log(`• "${slug}" → ${target}`);
  } else {
    writePartnerConfig(slug, entry);
    console.log(`✓ "${slug}" → ${target}`);
  }
  written++;
}

if (DRY_RUN) {
  console.log(`Dry-run: ${written} partner(s) would be written, ${skipped} left out; nothing modified.`);
  process.exit(0);
}

if (skipped === 0) {
  fs.unlinkSync(legacy);
  console.log(`✓ ${written} partner(s) migrated. Former file kept as ${backup} (no longer read).`);
} else {
  console.log(`${written} partner(s) migrated, ${skipped} left out. Full original kept as ${backup}; ${legacy} holds what is left (read for partners without their own file).`);
}
