#!/usr/bin/env node
// Automates the per-spreadsheet manual setup documented in
// scripts_online/google/README.md ("Extensions → Apps Script → add library →
// paste btsMenu.gs → save"): creates a fresh Apps Script project bound to the
// given spreadsheet and pushes btsMenu.gs plus a manifest declaring the BtsLib
// library dependency, via `clasp`. The BTS menu it installs isn't specific to
// events — it covers whatever chapters BtsApp.gs exposes (02 Tariff, 03 Season,
// 04 Event, ...), for any spreadsheet an operator wants it on.
//
// No credentials are written anywhere by this script — the bound project inherits
// everything from the BtsLib library's own Script Properties (see README's
// "Configuration" section for why that's where they belong, not per spreadsheet).
// Deploy/update the library itself with install-library.js.
//
// clasp itself is a project dependency (package.json) — `npm install` at the
// repo root provisions it in DEV/INT/PROD alike. The one remaining manual,
// per-host step is authenticating it:
//   clasp login   (or `clasp login --no-localhost` on a headless server)
//
// Usage:
//   node scripts_online/google/install/install-sheet-menu.js \
//     [--spreadsheet=<URL or ID>] \
//     (--library=<scriptId>:<version> | --library-id=<id> --library-version=<n>) \
//     [--title=<project title>] [--time-zone=Europe/Paris] [--dry-run]
//
// --spreadsheet omitted → creates a brand-new Google Sheet (clasp create
// --type sheets, no --parentId) instead of binding to an existing one.
//
// --library is the combined form the admin console's picker uses (populated
// from data/google-library-deployments.json, written by install-library.js —
// see lib/registry.js) so operators select a known-good library instead of
// copy-pasting a Script ID/version by hand. --library-id/--library-version
// remain available separately for manual/CLI use or a library not yet tracked
// in that registry.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { resolveClaspBin } from './lib/resolve-clasp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOOGLE_DIR = path.resolve(__dirname, '..');
const BTS_MENU_SRC = path.join(GOOGLE_DIR, 'btsMenu.gs');
const CLASP_BIN = resolveClaspBin();

const argv = yargs(hideBin(process.argv))
  .option('spreadsheet', { type: 'string', desc: 'URL Google Sheets ou ID de fichier Drive existant (omis = crée un nouveau classeur)' })
  .option('library', { type: 'string', desc: 'Forme combinée <scriptId>:<version> — ce que le sélecteur admin envoie' })
  .option('library-id', { type: 'string', default: process.env.BTS_GOOGLE_LIBRARY_ID, desc: 'Script ID du projet bibliothèque BtsApp (env: BTS_GOOGLE_LIBRARY_ID ; ignoré si --library est fourni)' })
  .option('library-version', { type: 'string', default: process.env.BTS_GOOGLE_LIBRARY_VERSION, desc: 'Numéro de version de la bibliothèque (env: BTS_GOOGLE_LIBRARY_VERSION ; ignoré si --library est fourni)' })
  .option('title', { type: 'string', desc: 'Titre du projet Apps Script (défaut: dérivé du nom du classeur)' })
  .option('time-zone', { type: 'string', default: 'Europe/Paris', desc: 'Fuseau horaire du manifeste appsscript.json' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Affiche les commandes clasp sans les exécuter' })
  .help()
  .argv;

function resolveLibrary() {
  if (argv.library) {
    const idx = argv.library.indexOf(':');
    if (idx === -1) {
      throw new Error(`--library invalide: "${argv.library}" (attendu: <scriptId>:<version>)`);
    }
    return { id: argv.library.slice(0, idx), version: argv.library.slice(idx + 1) };
  }
  return { id: argv['library-id'], version: argv['library-version'] };
}

function extractSpreadsheetId(raw) {
  const value = String(raw).trim();
  const match = value.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(value)) return value;
  throw new Error(`Impossible d'extraire un ID de fichier depuis "${raw}" (attendu: URL Google Sheets ou ID direct)`);
}

function run(cmd, args, cwd, log) {
  log(`→ ${cmd} ${args.join(' ')}`);
  if (argv['dry-run']) return { status: 0, stdout: '', stderr: '' };
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`"${cmd}" introuvable. clasp est une dépendance du projet — lancez "npm install" à la racine du dépôt.`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`"${cmd} ${args.join(' ')}" a échoué (code ${result.status})`);
  }
  return result;
}

function log(message) {
  console.log(message);
}

function main() {
  const library = resolveLibrary();
  if (!library.id) {
    throw new Error('--library-id requis (ou --library=<scriptId>:<version>, ou la variable d\'environnement BTS_GOOGLE_LIBRARY_ID) — Script ID de scripts_online/google/library/BtsApp.gs une fois déployé comme bibliothèque.');
  }
  if (!library.version) {
    throw new Error('--library-version requis (ou --library=<scriptId>:<version>, ou la variable d\'environnement BTS_GOOGLE_LIBRARY_VERSION) — numéro de version affiché lors du déploiement de la bibliothèque.');
  }
  if (!fs.existsSync(BTS_MENU_SRC)) {
    throw new Error(`Fichier source introuvable: ${BTS_MENU_SRC}`);
  }

  const creatingNew = !argv.spreadsheet;
  const spreadsheetId = creatingNew ? null : extractSpreadsheetId(argv.spreadsheet);
  const title = argv.title || (creatingNew
    ? `BTS — Nouveau classeur ${new Date().toISOString().slice(0, 10)}`
    : `BTS Menu — ${spreadsheetId.slice(0, 8)}`);

  log(creatingNew ? '→ Aucun classeur fourni : création d\'un nouveau Google Sheet.' : `→ Classeur cible: ${spreadsheetId}`);
  log(`→ Bibliothèque: ${library.id} (version ${library.version})`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-sheet-menu-install-'));
  log(`→ Répertoire de travail: ${workDir}`);

  if (creatingNew) {
    run(CLASP_BIN, ['create', '--type', 'sheets', '--title', title], workDir, log);
  } else {
    // Deliberately no --type here: clasp's own design is that --type is ignored
    // once --parentId is given (binding to the existing file), but passing both
    // has been observed to instead create a brand-new spreadsheet — so pass only
    // --parentId and let clasp bind purely off that.
    run(CLASP_BIN, ['create', '--parentId', spreadsheetId, '--title', title], workDir, log);
  }

  const claspJsonPath = path.join(workDir, '.clasp.json');
  let newSpreadsheetId = null;
  if (!argv['dry-run']) {
    if (!fs.existsSync(claspJsonPath)) {
      throw new Error('clasp create n\'a pas produit .clasp.json — abandon avant de risquer un push au mauvais endroit.');
    }
    if (creatingNew) {
      try {
        newSpreadsheetId = JSON.parse(fs.readFileSync(claspJsonPath, 'utf8')).parentId || null;
      } catch { /* best effort — reported below only if found */ }
    }
  }

  // clasp create scaffolds a default Code.js placeholder — remove it so only
  // btsMenu.gs (the actual entry point, calling into the BtsLib library) is
  // pushed; leaving both would register onOpen() twice.
  const scaffoldStub = path.join(workDir, 'Code.js');
  if (fs.existsSync(scaffoldStub)) fs.rmSync(scaffoldStub);

  fs.copyFileSync(BTS_MENU_SRC, path.join(workDir, 'btsMenu.gs'));
  log(`→ Copié: btsMenu.gs`);

  const manifest = {
    timeZone: argv['time-zone'],
    dependencies: {
      libraries: [
        { userSymbol: 'BtsLib', libraryId: library.id, version: String(library.version) }
      ]
    },
    exceptionLogging: 'STACKDRIVER',
    runtimeVersion: 'V8'
  };
  fs.writeFileSync(path.join(workDir, 'appsscript.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`→ Écrit: appsscript.json (dépendance BtsLib v${library.version})`);

  run(CLASP_BIN, ['push', '--force'], workDir, log);

  if (argv['dry-run']) {
    log('\n🧪 Dry-run — aucune commande clasp exécutée.');
    fs.rmSync(workDir, { recursive: true, force: true });
    return;
  }

  log('\n✅ Projet Apps Script créé et lié au classeur.');
  if (creatingNew) {
    if (newSpreadsheetId) {
      log(`   Nouveau classeur: https://docs.google.com/spreadsheets/d/${newSpreadsheetId}/edit`);
    } else {
      log('   ⚠ ID du nouveau classeur non détecté dans .clasp.json — retrouvez-le depuis votre Google Drive ("Récents").');
    }
  }
  log(`   Rechargez le classeur — le menu "BTS" doit apparaître (section "00 — Diagnostics" en premier, utile pour vérifier la config héritée de la bibliothèque).`);
  log(`   Copie locale (clasp) conservée dans: ${workDir}`);
  log(`   (le projet réel vit maintenant dans Google Drive, lié au classeur — ce répertoire local peut être supprimé sans risque, ou gardé pour ré-éditer via clasp plus tard)`);
}

try {
  main();
} catch (err) {
  console.error(`❌ ${err.message || err}`);
  process.exitCode = 1;
}
