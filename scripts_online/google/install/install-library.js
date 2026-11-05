#!/usr/bin/env node
// Deploys (or redeploys) the shared BtsApp Apps Script library — the manual
// "create a standalone Apps Script project, paste library/BtsApp.gs, deploy as
// a library, note the Script ID" step from scripts_online/google/README.md's
// Installation section. Run this once to create the library; run it again with
// --script-id to push an updated version of BtsApp.gs to the SAME project.
//
// Credentials (BASE_URL, JWT secret) are read and printed ready-to-paste, but
// deliberately NOT written automatically. An earlier version tried writing
// them via `clasp run installConfig` against the Apps Script Execution API —
// dropped after real-world testing failed identically with both
// executionApi.access "MYSELF" and "ANYONE" ("Unable to run script function.
// Please make sure you have permission to run the script function."), most
// likely because clasp's default OAuth client doesn't request the scope the
// Execution API needs (a custom OAuth client via `clasp login --creds <file>`
// would very likely fix it, but that's a materially bigger setup — Cloud
// Console project, OAuth consent screen — for what's ultimately a convenience
// over one manual paste). Printing the values keeps the one remaining step
// reliable and simple: paste them once into the Apps Script editor (Project
// settings → Script properties) on the library project itself.
//
// Two ways to source credentials for printing — pick one, not both:
//   --feed-credentials       reads them from THIS server's own .env
//                             (APP_URL/BASE_PATH, AUTOMATION_JWT_SECRET,
//                             AUTOMATION_JWT_ISS/AUD/SCOPES if set) — no
//                             hunting down the JWT secret by hand.
//   --base-url + --secret    explicit values, e.g. feeding a DIFFERENT BTS
//                             instance's credentials than the one this script
//                             happens to run next to.
//
// clasp itself is a project dependency (package.json) — `npm install` at the
// repo root provisions it in DEV/INT/PROD alike. The one remaining manual,
// per-host step is authenticating it:
//   npx clasp login   (or `npx clasp login --no-localhost` on a headless server)
//
// Usage:
//   node scripts_online/google/install/install-library.js \
//     [--script-id=<existing library Script ID>] \
//     [--title="BTS Automation Library"] \
//     [--version-description="..."] \
//     [--feed-credentials | --base-url=<url> --secret=<jwt-secret>] \
//     [--iss=] [--aud=] [--scopes=] \
//     [--dry-run]
import 'dotenv/config'; // must be the first import — see resolveCredentials()'s use of process.env
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { resolveClaspBin } from './lib/resolve-clasp.js';
import { upsertLibrary, getClaspGoogleUser } from './lib/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOOGLE_DIR = path.resolve(__dirname, '..');
const LIBRARY_SRC = path.join(GOOGLE_DIR, 'library', 'BtsApp.gs');
const CLASP_BIN = resolveClaspBin();

const argv = yargs(hideBin(process.argv))
  .option('script-id', { type: 'string', desc: 'Script ID existant à mettre à jour (omis = créer un nouveau projet)' })
  .option('title', { type: 'string', default: 'BTS Automation Library', desc: 'Titre du projet (nouveau projet uniquement)' })
  .option('version-description', { type: 'string', default: 'Automated deploy via install-library.js', desc: 'Description de la version créée' })
  .option('feed-credentials', { type: 'boolean', default: false, desc: 'Lit BASE_URL/secret depuis le .env de ce serveur (APP_URL+BASE_PATH, AUTOMATION_JWT_SECRET) et les affiche prêts à coller' })
  .option('base-url', { type: 'string', desc: 'BTS_AUTOMATION_BASE_URL à afficher (nécessite --secret ; incompatible avec --feed-credentials)' })
  .option('secret', { type: 'string', desc: 'BTS_AUTOMATION_SECRET à afficher (nécessite --base-url ; incompatible avec --feed-credentials)' })
  .option('iss', { type: 'string', desc: 'BTS_AUTOMATION_ISS (défaut: AUTOMATION_JWT_ISS de l\'env, sinon "google-sheets")' })
  .option('aud', { type: 'string', desc: 'BTS_AUTOMATION_AUD (défaut: AUTOMATION_JWT_AUD de l\'env, sinon "bts-automation")' })
  .option('scopes', { type: 'string', desc: 'BTS_AUTOMATION_SCOPES (défaut: AUTOMATION_JWT_SCOPES de l\'env, sinon un jeu par défaut)' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Affiche les commandes clasp sans les exécuter' })
  .help()
  .argv;

const DEFAULT_ISS = 'google-sheets';
const DEFAULT_AUD = 'bts-automation';
const DEFAULT_SCOPES = 'automation:jobs:write automation:jobs:run automation:jobs:read';

function resolveCredentials() {
  if (argv['feed-credentials']) {
    const appUrl = (process.env.APP_URL || '').trim();
    const basePath = (process.env.BASE_PATH || '').trim();
    const secret = (process.env.AUTOMATION_JWT_SECRET || '').trim();
    if (!appUrl || !secret) {
      throw new Error('--feed-credentials requiert APP_URL et AUTOMATION_JWT_SECRET dans le .env de ce serveur (introuvables ou vides).');
    }
    return {
      baseUrl: appUrl.replace(/\/$/, '') + basePath,
      secret,
      iss: (process.env.AUTOMATION_JWT_ISS || '').trim() || DEFAULT_ISS,
      aud: (process.env.AUTOMATION_JWT_AUD || '').trim() || DEFAULT_AUD,
      scopes: (process.env.AUTOMATION_JWT_SCOPES || '').trim() || DEFAULT_SCOPES
    };
  }
  if (argv['base-url'] || argv.secret) {
    if (!(argv['base-url'] && argv.secret)) {
      throw new Error('--base-url et --secret doivent être fournis ensemble (ou aucun des deux).');
    }
    return {
      baseUrl: argv['base-url'],
      secret: argv.secret,
      iss: argv.iss || DEFAULT_ISS,
      aud: argv.aud || DEFAULT_AUD,
      scopes: argv.scopes || DEFAULT_SCOPES
    };
  }
  return null;
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
  if (!fs.existsSync(LIBRARY_SRC)) {
    throw new Error(`Fichier source introuvable: ${LIBRARY_SRC}`);
  }
  if (argv['feed-credentials'] && (argv['base-url'] || argv.secret)) {
    throw new Error('--feed-credentials et --base-url/--secret sont deux façons alternatives de fournir les identifiants — utilisez l\'une ou l\'autre, pas les deux.');
  }
  const creds = resolveCredentials();

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-library-install-'));
  log(`→ Répertoire de travail: ${workDir}`);

  if (argv['script-id']) {
    log(`→ Mise à jour du projet existant: ${argv['script-id']}`);
    fs.writeFileSync(
      path.join(workDir, '.clasp.json'),
      JSON.stringify({ scriptId: argv['script-id'], rootDir: '.' }, null, 2) + '\n'
    );
  } else {
    run(CLASP_BIN, ['create', '--type', 'standalone', '--title', argv.title], workDir, log);
    if (!argv['dry-run'] && !fs.existsSync(path.join(workDir, '.clasp.json'))) {
      throw new Error('clasp create n\'a pas produit .clasp.json — abandon.');
    }
    const scaffoldStub = path.join(workDir, 'Code.js');
    if (fs.existsSync(scaffoldStub)) fs.rmSync(scaffoldStub);
  }

  fs.copyFileSync(LIBRARY_SRC, path.join(workDir, 'BtsApp.gs'));
  log('→ Copié: library/BtsApp.gs');

  const manifest = {
    timeZone: 'Europe/Paris',
    exceptionLogging: 'STACKDRIVER',
    runtimeVersion: 'V8'
  };
  fs.writeFileSync(path.join(workDir, 'appsscript.json'), JSON.stringify(manifest, null, 2) + '\n');
  log('→ Écrit: appsscript.json');

  run(CLASP_BIN, ['push', '--force'], workDir, log);

  const versionResult = run(CLASP_BIN, ['version', argv['version-description']], workDir, log);

  if (argv['dry-run']) {
    log('\n🧪 Dry-run — aucune commande clasp exécutée.');
    fs.rmSync(workDir, { recursive: true, force: true });
    return;
  }

  const scriptId = argv['script-id'] || JSON.parse(fs.readFileSync(path.join(workDir, '.clasp.json'), 'utf8')).scriptId;
  const versionMatch = (versionResult.stdout || '').match(/version\s+(\d+)/i);
  const version = versionMatch ? versionMatch[1] : null;

  log('\n✅ Bibliothèque déployée.');
  log(`   Script ID: ${scriptId}`);
  if (version) {
    log(`   Version: ${version}`);
    log('\n   Pour install-sheet-menu.js (ou .env du serveur BTS):');
    log(`     export BTS_GOOGLE_LIBRARY_ID=${scriptId}`);
    log(`     export BTS_GOOGLE_LIBRARY_VERSION=${version}`);
  } else {
    log('   ⚠ Numéro de version non détecté dans la sortie clasp ci-dessus — relevez-le manuellement.');
  }

  const { email: googleUser, reason: googleUserReason } = getClaspGoogleUser();
  // Only set title on a fresh create — on --script-id updates, argv.title still
  // carries its generic default ('BTS Automation Library') even though the
  // user didn't ask to rename anything, so don't let it clobber whatever title
  // is already on record for this project.
  upsertLibrary({ scriptId, title: argv['script-id'] ? undefined : argv.title, version, googleUser });
  log(`\n   → Enregistré dans data/google-library-deployments.json${googleUser ? ` (compte: ${googleUser})` : ''} — sélectionnable depuis "Install Google Sheet BTS Menu" au lieu de coller Script ID/version.`);
  if (!googleUser && googleUserReason) {
    log(`   ⚠ Compte Google non détecté automatiquement: ${googleUserReason}`);
  }

  if (creds) {
    log(`\n→ Identifiants (source: ${argv['feed-credentials'] ? '.env de ce serveur' : 'arguments --base-url/--secret'}) — à coller une fois dans ce projet:`);
    log('   script.google.com → ce projet → Project settings → Script properties:');
    log(`     BTS_AUTOMATION_BASE_URL = ${creds.baseUrl}`);
    log(`     BTS_AUTOMATION_SECRET = ${creds.secret}`);
    log(`     BTS_AUTOMATION_ISS = ${creds.iss}`);
    log(`     BTS_AUTOMATION_AUD = ${creds.aud}`);
    log(`     BTS_AUTOMATION_SCOPES = ${creds.scopes}`);
  } else {
    log('\nℹ Identifiants non fournis — à définir une fois, à la main, dans ce projet:');
    log('   script.google.com → ce projet → Project settings → Script properties');
    log('   (ou relancez ce script avec --script-id=' + scriptId + ' --feed-credentials, ou --base-url=... --secret=... pour les afficher prêts à coller)');
  }

  log(`\n   Copie locale (clasp) conservée dans: ${workDir}`);
}

try {
  main();
} catch (err) {
  console.error(`❌ ${err.message || err}`);
  process.exitCode = 1;
}
