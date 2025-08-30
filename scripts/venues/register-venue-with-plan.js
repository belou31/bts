#!/usr/bin/env node
/**
 * Copie un plan SVG où qu'il soit vers:
 *   src/public/venues/<slug>/plan.svg
 * puis enregistre le lieu en base via register-venue.js
 *
 * Usage:
 *   node scripts/venues/register-venue-with-plan.js <slug> "<Nom du lieu>" </chemin/vers/plan.svg> [--no-overwrite]
 *
 * Exemple:
 *   node scripts/venues/register-venue-with-plan.js patinoire-blagnac "Patinoire de Blagnac" /tmp/plan-blagnac.svg
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import dotenv from 'dotenv';
dotenv.config();

function die(msg) { console.error(msg); process.exit(1); }

const argv = process.argv.slice(2);
if (argv.length < 3) {
  die('Usage: node scripts/venues/register-venue-with-plan.js <slug> "<Nom du lieu>" </chemin/vers/plan.svg> [--no-overwrite]');
}
const slug = argv[0];
const name = argv[1];
const svgSrcArg = argv[2];
const noOverwrite = argv.includes('--no-overwrite');

const absSrc = path.resolve(svgSrcArg);
if (!fs.existsSync(absSrc)) die(`Plan introuvable: ${absSrc}`);
if (path.extname(absSrc).toLowerCase() !== '.svg') {
  die('Le fichier fourni doit être un .svg');
}

// Dossier de destination: src/public/venues/<slug>/plan.svg
const destDir = path.resolve('src/public/venues', slug);
const destSvg = path.join(destDir, 'plan.svg');
fs.mkdirSync(destDir, { recursive: true });

// Si --no-overwrite et déjà présent, on n’écrase pas
if (noOverwrite && fs.existsSync(destSvg)) {
  console.log(`⚠️  ${destSvg} existe déjà — non modifié (--no-overwrite)`);
} else {
  fs.copyFileSync(absSrc, destSvg);
  console.log(`✓ Plan copié → ${destSvg}`);
}

// Appel du script existant qui enregistre le lieu (DB)
const res = spawnSync(process.execPath, ['scripts/venues/register-venue.js', slug, name], { stdio: 'inherit' });
if (res.status !== 0) process.exit(res.status);

console.log('✓ Lieu enregistré et plan en place.');
console.log(`→ Le plan sera servi à: /venues/${slug}/plan.svg`);
