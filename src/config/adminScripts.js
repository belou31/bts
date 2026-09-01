// src/config/adminScripts.js
/**
 * Script catalog exposed in the admin interface.
 * Each entry describes how the script is invoked, what it does,
 * and which optional templates should be suggested to operators.
 *
 * The `command` field is the default CLI command (relative to repo root)
 * that will be executed when triggered from the admin UI. It can contain
 * placeholder tokens such as <seasonCode> that the UI can surface before run.
 */

export const adminScriptGroups = [
  {
    id: '00-system-management',
    label: '00 — System',
    order: 0,
    description: 'Initialization tasks that prepare the environment, validate configuration, and stage tenant-specific assets.',
    scripts: [
      {
        id: 'reset-db',
        label: 'Reset MongoDB Database',
        order: 0,
        path: 'scripts/00-system-management/reset-db.js',
        command: 'node scripts/00-system-management/reset-db.js --force',
        run: {
          script: 'scripts/00-system-management/reset-db.js',
          args: ['--force']
        },
        description: 'Drops the MongoDB database defined in .env. Requires the --force flag to avoid accidental wipes.',
        danger: true,
        templates: ['data_references/env/.env.template'],
        notes: [
          'Make sure the MongoDB URI points to the intended environment before running.',
          'Include --force to acknowledge the drop command.'
        ]
      },
      {
        id: 'sync-indexes',
        label: 'Synchroniser les index (MongoDB)',
        order: 0.5,
        path: 'scripts/sync-indexes.mjs',
        command: 'node scripts/sync-indexes.mjs [--apply]',
        run: {
          script: 'scripts/sync-indexes.mjs',
          args: []
        },
        description: 'Crée les index manquants et recrée ceux qui ont dérivé du schéma, pour tous les modèles. À lancer après chaque déploiement, et OBLIGATOIREMENT après un « Reset MongoDB Database » sur INT/PROD.',
        notes: [
          'Hors développement, l\'application ne crée AUCUN index toute seule : src/loaders/mongoose.js connecte avec autoIndex = (APP_ENV === "development"). Après un reset, la base tourne donc sans une seule contrainte d\'unicité — prix en double, deux commandes payées pour la même place, deux verrous sur le même siège passent en silence.',
          'Sans « Appliquer », le script se contente de lister ce qui manque, modèle par modèle. Rien n\'est écrit.',
          'Non destructif pour les données, mais un index qui a changé d\'options est supprimé puis recréé : sur une grosse collection, la reconstruction peut durer. La page peut expirer avant la fin — le script, lui, continue côté serveur et va au bout.',
          'Si MongoDB refuse un index, le script le signale sur stderr et poursuit : un modèle en échec n\'empêche pas les autres d\'être synchronisés.'
        ],
        form: {
          fields: [
            {
              name: 'apply',
              label: 'Appliquer (sinon : simple inventaire)',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--apply' }
            }
          ]
        }
      },
      {
        id: 'check-env',
        label: 'Validate Environment (.env)',
        order: 1,
        path: 'scripts/00-system-management/check-env.js',
        command: 'node scripts/00-system-management/check-env.js',
        run: {
          script: 'scripts/00-system-management/check-env.js',
          args: []
        },
        description: 'Verifies the consistency of APP_URL/BASE_PATH and payment provider configuration for the current APP_ENV.'
      },
      {
        id: 'purge-logs',
        label: 'Purge Logs (Mongo)',
        order: 4,
        path: 'scripts/00-system-management/purge-logs.js',
        command: 'node scripts/00-system-management/purge-logs.js --apply',
        run: {
          script: 'scripts/00-system-management/purge-logs.js',
          args: ['--apply']
        },
        description: 'Supprime les logs opérationnels : collections ScanLog et journaux intégrés aux jobs automation.',
        danger: true,
        notes: [
          'Exécution immédiate (pas de dry-run).',
          'Assurez-vous de viser l’environnement correct avant de purger.'
        ]
      },
      {
        id: 'pm2-restart-bts',
        label: 'Restart BTS (pm2)',
        order: 4,
        path: 'scripts/00-system-management/pm2-control.js',
        command: 'node scripts/00-system-management/pm2-control.js --name=bts --action=restart',
        run: {
          script: 'scripts/00-system-management/pm2-control.js',
          args: ['--name=bts', '--action=restart']
        },
        description: 'Redémarre le processus principal BTS via pm2 (démarre si absent).',
        danger: true,
        notes: [
          'Nécessite pm2 installé et configuré sur l’hôte.',
          'Utilise pm2 restart, puis start en fallback si le process est absent.'
        ]
      },
      {
        id: 'pm2-restart-sentinel',
        label: 'Start/Restart bts-sentinel (pm2)',
        order: 5,
        path: 'scripts/00-system-management/pm2-control.js',
        command: 'node scripts/00-system-management/pm2-control.js --name=bts-sentinel --action=restart',
        run: {
          script: 'scripts/00-system-management/pm2-control.js',
          args: ['--name=bts-sentinel', '--action=restart']
        },
        description: 'Démarre ou redémarre le sentinel pm2 (bts-sentinel).',
        danger: true,
        notes: [
          'Nécessite pm2 installé et la config du process bts-sentinel disponible.',
          'Fait un restart, puis start en fallback.'
        ]
      },
      {
        id: 'pm2-restart-logrotate',
        label: 'Start/Restart pm2-logrotate',
        order: 6,
        path: 'scripts/00-system-management/pm2-control.js',
        command: 'node scripts/00-system-management/pm2-control.js --name=pm2-logrotate --action=restart',
        run: {
          script: 'scripts/00-system-management/pm2-control.js',
          args: ['--name=pm2-logrotate', '--action=restart']
        },
        description: 'Démarre ou redémarre le service de rotation des logs (pm2: pm2-logrotate).',
        danger: true,
        notes: [
          'Nécessite pm2 installé et la config du process bts-logrotate disponible.',
          'Fait un restart, puis start en fallback.'
        ]
      }
    ]
  },
  {
    id: '00-client-management',
    label: '00 — Client',
    // Same "00 -" insertion technique as the season-renewal chapter (order
    // 3.5): a new chapter between System (0) and Organization (0.6), no
    // renumbering. Sorts before Organization: 00 System > 00 Client >
    // 01 Organization > 01 Venue > 02 Tariff ...
    order: 0.3,
    description: 'Deployment tooling for what runs on an operator/client\'s own side: the downloadable BTS Desktop bundle, and the Google Sheets integration (shared library + per-event spreadsheet).',
    guide: {
      title: 'Google Auth — clasp step-by-step',
      // Rendered between these two script cards (not above the whole chapter)
      // since it's specifically about the two Google-script cards that follow,
      // not the desktop bundle download above it.
      afterScriptId: 'download-desktop-bundle',
      steps: [
        'Required once per server host, before either Google script below will work — <code>clasp</code> is a project dependency (<code>npm install</code>), not a global command, so it must be authenticated from inside the repo.',
        '<code>ssh &lt;server&gt;</code> — connect to the server.',
        '<code>sudo -iu &lt;user&gt;</code> — become the OS user the BTS server runs as (e.g. <code>belou</code>).',
        '<code>cd bts</code> — the repo root (adjust if it lives elsewhere).',
        '<code>npx clasp login --no-localhost</code> — authenticate clasp for THIS user.',
        'Open the printed URL in any browser (your own laptop\'s is fine) and complete Google\'s consent screen.',
        'It redirects to a broken <code>http://localhost:.../</code> page — that\'s expected, nothing is meant to be listening there. Copy the <strong>entire</strong> address bar URL (not just the <code>code=</code> value) and paste that whole thing back into the terminal, which is waiting for it.',
        'One-time per Google account, separate from clasp login: visit <a href="https://script.google.com/home/usersettings" target="_blank" rel="noopener">script.google.com/home/usersettings</a> and enable the "Google Apps Script API" toggle. Wait a minute or two for it to propagate, then retry the script below if it just failed with "User has not enabled the Apps Script API."',
'"Install/Update Google App BTS Library" prints the credential values ready to paste, but doesn\'t write them for you (an automatic path via <code>clasp run</code> was tried and dropped — unreliable regardless of executionApi access level). Paste them once into the <strong>library</strong> project itself (the standalone one deployed as a library, not a spreadsheet\'s bound script — Script Properties are isolated per project) in script.google.com → Project settings → Script properties.'
      ]
    },
    scripts: [
      {
        id: 'download-desktop-bundle',
        label: 'Download BTS Desktop',
        order: 0,
        command: 'Téléchargement direct — voir le lien ci-dessous',
        description: 'Downloads a zip of scripts_desktop/ (LibreOffice macros, CLI, GUI credentials installer, Excel/Numbers stubs) plus automation_client/, the shared Python package they all depend on — everything needed to run the desktop installer (scripts_desktop/gui/installer.py) on an operator\'s own machine.',
        templates: ['scripts_desktop.zip'],
        notes: [
          'This entry has no CLI command — use the download link below, not "Exécuter".',
          'The zip is generated on the fly from the current checkout, so it always matches what this BTS instance is actually running.',
          'After extracting: python3 scripts_desktop/gui/installer.py (see scripts_desktop/README.md for per-surface details).'
        ]
      },
      {
        id: 'install-google-library',
        label: 'Install/Update Google App BTS Library',
        order: 1,
        path: 'scripts_online/google/install/install-library.js',
        command: 'node scripts_online/google/install/install-library.js [--script-id=<id>] [--feed-credentials]',
        run: {
          script: 'scripts_online/google/install/install-library.js',
          args: []
        },
        description: 'Deploys (or redeploys) the shared BtsApp Apps Script library that every spreadsheet\'s BTS menu attaches to. Leave "Script ID" blank the first time to create it; fill it in on later runs to push updates to the same project. "Feed credentials" reads BASE_URL/secret straight from this server\'s own .env and prints them ready to paste, instead of hunting them down by hand.',
        notes: [
          'clasp needs authenticating once per server host before this works — see the "Google Auth — clasp step-by-step" box above.',
          'First run: leave "Script ID" blank. Note the printed Script ID + version afterwards — needed by "Install Google Sheet BTS Menu" below (as BTS_GOOGLE_LIBRARY_ID / BTS_GOOGLE_LIBRARY_VERSION in .env, or pasted per run).',
          'Later runs (pushing an updated BtsApp.gs): fill in the same Script ID so it updates the existing project instead of creating a new one.',
          '"Feed credentials" reads APP_URL+BASE_PATH and AUTOMATION_JWT_SECRET from THIS server\'s own .env — the same secret already used to validate incoming automation JWTs — and prints them. Paste them once into script.google.com → this project → Project settings → Script properties. (An earlier version tried writing them automatically via the Apps Script Execution API — dropped after real-world testing failed regardless of executionApi access level; not worth the added complexity/attack surface for one manual paste.)'
        ],
        form: {
          fields: [
            {
              name: 'scriptId',
              label: 'Script ID (optionnel — vide = nouveau projet)',
              arg: { type: 'option', template: '--script-id=${value}' }
            },
            {
              name: 'feedCredentials',
              label: 'Afficher les identifiants de ce serveur (.env), prêts à coller',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--feed-credentials' }
            }
          ]
        }
      },
      {
        id: 'install-google-sheet-menu',
        label: 'Install Google Sheet BTS Menu',
        order: 2,
        path: 'scripts_online/google/install/install-sheet-menu.js',
        command: 'node scripts_online/google/install/install-sheet-menu.js [--spreadsheet=<URL>] --library=<scriptId>:<version>',
        run: {
          script: 'scripts_online/google/install/install-sheet-menu.js',
          args: []
        },
        description: 'Binds a new Apps Script project to a Google Sheet and pushes the BTS menu — not limited to event spreadsheets, whatever chapters BtsApp.gs exposes (tariffs, seasons, events, ...) come along. Leave the Google Sheet field blank to create a brand-new spreadsheet instead of binding to an existing one. No credentials are written — the new project inherits everything from the BtsLib library\'s own Script Properties (see scripts_online/google/README.md).',
        notes: [
          'clasp needs authenticating once per server host before this works — see the "Google Auth — clasp step-by-step" box above. Without it, every run fails with "No credentials found."',
          'Requires the library to be deployed first — see "Install/Update Google App BTS Library" above, which registers it here for selection.',
          'Library not listed? It hasn\'t been deployed via "Install/Update Google App BTS Library" yet (only libraries deployed that way are tracked in data/google-library-deployments.json) — deploy it there first, or use the CLI directly with --library-id/--library-version.',
          'Leaving "Google Sheet" blank creates a new spreadsheet (clasp create --type sheets) and prints its URL at the end — check the run output for the link.',
          'After a successful run, reload the target spreadsheet — the BTS menu appears; run 00 — Diagnostics → Vérifier configuration from it to confirm credentials resolved from the library.',
          'See scripts_online/google/install/README.md for troubleshooting.'
        ],
        form: {
          fields: [
            {
              name: 'spreadsheet',
              label: 'Google Sheet (URL ou ID) — vide = créer un nouveau classeur',
              placeholder: 'https://docs.google.com/spreadsheets/d/…',
              arg: { type: 'option', template: '--spreadsheet=${value}' }
            },
            {
              name: 'library',
              label: 'Bibliothèque Google (déployée via "Install/Update Google App BTS Library")',
              required: true,
              arg: { type: 'option', template: '--library=${value}' }
            }
          ]
        }
      }
    ]
  },
  {
    id: '00-organization-management',
    label: '01 — Organization',
    // Between Client (0.3) and Venue (1), without renumbering either — same
    // technique as 03-season-management-renewal's 3.5. More scripts expected
    // here later (payment provider setup, email account, ...), hence its own
    // chapter rather than folding into System. Labeled "01" (shares the
    // number with Venue) rather than "00": 00 System > 00 Client >
    // 01 Organization > 01 Venue > 02 Tariff ...
    order: 0.6,
    description: 'Organization-wide setup: branding and default customization today; payment provider, email account, and similar org-level configuration expected to land here too.',
    scripts: [
      {
        id: 'customize-app',
        label: 'Customize Application',
        order: 0,
        path: 'scripts/00-system-management/customize-app.js',
        command: 'node scripts/00-system-management/customize-app.js --name="<Organization>" [--short-name="<Short>"] [--logo-svg=logo.svg] [--logo-png=logo.png] [--favicon=favicon.ico] [--icon-192=icon-192.png] [--icon-512=icon-512.png]',
        run: {
          script: 'scripts/00-system-management/customize-app.js',
          args: []
        },
        description: 'Stages organization assets (favicon, logos, app icons) to public/dynamic/assets and saves metadata under data/customization.',
        templates: ['data_references/customization/app.json'],
        notes: [
          'Input files can be referenced by absolute path or relative to data/inputs.',
          'Use --dry-run to preview the configuration without writing files.',
          'Run with --show to print the current customization metadata.'
        ],
        form: {
          fields: [
            {
              name: 'name',
              label: 'Nom complet de l’organisation',
              placeholder: 'Belougas Ticketing System',
              arg: { type: 'option', template: '--name=${value}' }
            },
            {
              name: 'shortName',
              label: 'Nom abrégé',
              placeholder: 'BTS',
              arg: { type: 'option', template: '--short-name=${value}' }
            },
            {
              name: 'favicon',
              label: 'Favicon (.ico)',
              placeholder: 'public/dynamic/assets/favicon.ico',
              arg: { type: 'option', template: '--favicon=${value}' }
            },
            {
              name: 'logoSvg',
              label: 'Logo vectoriel (.svg)',
              placeholder: 'public/dynamic/assets/logo.svg',
              arg: { type: 'option', template: '--logo-svg=${value}' }
            },
            {
              name: 'logoPng',
              label: 'Logo bitmap (.png)',
              placeholder: 'public/dynamic/assets/logo.png',
              arg: { type: 'option', template: '--logo-png=${value}' }
            },
            {
              name: 'icon192',
              label: 'Icône 192×192 (.png)',
              placeholder: 'public/dynamic/assets/icon-192.png',
              arg: { type: 'option', template: '--icon-192=${value}' }
            },
            {
              name: 'icon512',
              label: 'Icône 512×512 (.png)',
              placeholder: 'public/dynamic/assets/icon-512.png',
              arg: { type: 'option', template: '--icon-512=${value}' }
            }
          ]
        }
      },
      {
        id: 'set-default-custo',
        label: 'Set Default Customization',
        order: 1,
        path: 'scripts/00-system-management/set-default-custo.js',
        command: 'node scripts/00-system-management/set-default-custo.js --file=<customization.json>',
        run: {
          script: 'scripts/00-system-management/set-default-custo.js',
          args: []
        },
        description: 'Writes default UI/email copy customizations to data/customization/default.json.',
        templates: ['data/customization/default.json'],
        form: {
          fields: [
            {
              name: 'file',
              label: 'JSON customization',
              placeholder: 'data/customization/default.json',
              required: true,
              arg: { type: 'option', template: '--file=${value}' }
            }
          ]
        }
      },
      {
        id: 'set-payment-provider',
        label: 'Set Payment Provider',
        order: 3,
        path: 'scripts/00-system-management/set-payment-provider.js',
        command: 'node scripts/00-system-management/set-payment-provider.js --provider=<helloasso|mollie|sumup> [--name="<Label>"]',
        run: {
          script: 'scripts/00-system-management/set-payment-provider.js',
          args: []
        },
        description: 'Switches the active payment provider by updating PAYMENT_PROVIDER (and optionally PAYMENT_PROVIDER_NAME) in .env, leaving every other line — including other providers\' secrets — untouched.',
        notes: [
          'The provider list comes directly from src/services/payments/index.js, so it can never offer a provider the code doesn\'t actually support.',
          'Each provider\'s own credentials live in its .env.<provider> file — this script only switches which provider is active, it does not edit credentials.',
          'PAYMENT_PROVIDER is cached in memory at server start — restart the server for the change to take effect.',
          'Use --dry-run to preview the .env diff without writing.'
        ],
        form: {
          fields: [
            {
              name: 'provider',
              label: 'Provider',
              required: true,
              arg: { type: 'option', template: '--provider=${value}' },
              options: [
                { label: 'HelloAsso', value: 'helloasso' },
                { label: 'Mollie', value: 'mollie' },
                { label: 'SumUp', value: 'sumup' }
              ]
            },
            {
              name: 'name',
              label: 'Libellé affiché (optionnel)',
              placeholder: 'SumUp',
              arg: { type: 'option', template: '--name=${value}' }
            }
          ]
        }
      }
    ]
  },
  {
    id: '03-season-management-renewal',
    label: '03 — Season · Renewal',
    order: 3.5,
    description: 'Renewal-focused tooling: import legacy subscribers, provision their seats, publish renewal links, and close the campaign.',
    scripts: [
      {
        id: 'import-renewers-flat',
        label: 'Import Renewal Subscribers (flat CSV)',
        order: 0,
        path: 'scripts/03-season-management/import-renewers-flat.js',
        command: 'node scripts/03-season-management/import-renewers-flat.js <path/to/subscribers.csv> <seasonCode> --venue=<slug> [--extra=<n>]',
        run: {
          script: 'scripts/03-season-management/import-renewers-flat.js',
          args: []
        },
        description: 'Loads renewal subscribers from a simple CSV (one seat per row) and marks them as invited. An optional "extra" column grants a renewer places beyond the seats they already had.',
        templates: ['data_references/csv/renew-subscribers.template.csv'],
        notes: [
          'extra = places supplémentaires autorisées en plus des sièges précédents. La colonne CSV prime ; le champ ci-dessous ne sert que de valeur par défaut pour les lignes qui ne la renseignent pas.',
          'Le quota d\'un lien de renouvellement est calculé par groupe (groupKey) en prenant le MAX des extra du groupe, jamais la somme : marquer extra=1 sur les 3 lignes d\'une famille accorde 1 place de plus, pas 3.',
          'Les sièges précédents restent provisionnés mais ne sont plus imposés : le renouveleur peut en changer, dans la limite de son quota (sièges précédents + extra).'
        ],
        form: {
          fields: [
            {
              name: 'csv',
              label: 'CSV abonnés',
              placeholder: 'data/inputs/subscribers.csv',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'positional', index: 1 }
            },
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'extra',
              label: 'Places supplémentaires par défaut (optionnel — défaut 0)',
              placeholder: '0',
              hint: 'Utilisé uniquement pour les lignes sans colonne "extra" dans le CSV.',
              arg: { type: 'option', template: '--extra=${value}' }
            }
          ]
        }
      },
      {
        id: 'renewal-provision',
        label: 'Provision Seats for Renewal',
        order: 1,
        path: 'scripts/03-season-management/renewal-provision-seats.js',
        command: 'node scripts/03-season-management/renewal-provision-seats.js <seasonCode> --venue=<slug> [--apply]',
        run: {
          script: 'scripts/03-season-management/renewal-provision-seats.js',
          args: []
        },
        description: 'Tags previous-season seats as provisioned so subscribers can renew them.',
        notes: [
          'Dry-run by default; add --apply to persist updates in MongoDB.'
        ],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'venue',
              label: 'Slug du lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            }
          ]
        }
      },
      {
        id: 'remove-renewers',
        label: 'Remove Renewers (clean restart)',
        order: 5,
        path: 'scripts/03-season-management/remove-renewers.js',
        command: 'node scripts/03-season-management/remove-renewers.js --season=<code> [--venue=<slug>] [--commit] [--release-seats]',
        run: { script: 'scripts/03-season-management/remove-renewers.js', args: [] },
        description: 'Supprime les lignes de renouvellement d\'une saison pour repartir d\'un import propre.',
        danger: true,
        notes: [
          'Sans « Supprimer », rien n\'est écrit : le script affiche le nombre de lignes, de places, de sièges provisionnés et de renouvellements déjà payés.',
          'Refuse de supprimer tant que des sièges sont provisionnés pour ces renouveleurs : les effacer laisserait des places bloquées pointant vers des abonnés inexistants. Cocher « Libérer les sièges » pour faire les deux.',
          'Ne touche ni aux sièges `booked` ni aux commandes : un renouvellement déjà payé le reste.',
          'Enchaîner ensuite avec Import Renewers (flat CSV).'
        ],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2026-2027',
              required: true,
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'venue',
              label: 'Slug du lieu (optionnel)',
              placeholder: 'stadium',
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'commit',
              label: 'Supprimer (sinon état des lieux)',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--commit' }
            },
            {
              name: 'releaseSeats',
              label: 'Libérer aussi les sièges provisionnés',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--release-seats' }
            }
          ]
        }
      },
      {
        id: 'release-unrenewed-seats',
        label: 'Release Unrenewed Seats',
        order: 4,
        path: 'scripts/03-season-management/release-unrenewed-seats.js',
        command: 'node scripts/03-season-management/release-unrenewed-seats.js <seasonCode> [--venue=<slug>] [--dry-run]',
        run: {
          script: 'scripts/03-season-management/release-unrenewed-seats.js',
          args: []
        },
        description: 'Rend au public les sièges provisionnés qu\'un abonné n\'a pas renouvelés.',
        notes: [
          'Ne touche que les sièges encore `provisioned` : un siège renouvelé est `booked` et reste en place.',
          'Fermez d\'abord le renouvellement (`publish-season.js --renew=closed`), sinon on reprend leur place à des abonnés en cours.',
          'Utilisez --dry-run pour compter sans rien modifier, et --venue pour se limiter à un lieu.'
        ],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'venue',
              label: 'Slug du lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'dryRun',
              label: 'Simulation (aucune écriture)',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--dry-run' }
            }
          ]
        }
      },
      {
        id: 'export-renew-groups',
        label: 'Export Renewal Tokens',
        order: 2,
        path: 'scripts/03-season-management/export-renew-groups.js',
        command: 'node scripts/03-season-management/export-renew-groups.js <seasonCode> --venue=<slug> --base=<https://host/bts> --out=<file.csv>',
        run: {
          script: 'scripts/03-season-management/export-renew-groups.js',
          args: []
        },
        description: 'Generates renewal tokens grouped by subscriber, exporting a CSV ready for emailing.',
        notes: [
          'Requires JWT_SECRET and a public base URL (use --base to override APP_URL).',
          'Résultats déposés par défaut dans data/outputs.'
        ],
        templates: ['data_references/csv/renew-groups.template.csv'],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'base',
              label: 'URL de base pour les liens',
              placeholder: 'https://billetterie.example/bts',
              required: true,
              arg: { type: 'option', template: '--base=${value}' }
            },
            {
              name: 'out',
              label: 'Fichier de sortie (optionnel)',
              placeholder: 'renew-groups.csv',
              arg: { type: 'option', template: '--out=${value}' }
            }
          ]
        }
      },
      {
        id: 'send-renew-invites',
        label: 'Send Renewal Invitations',
        order: 2.5,
        path: 'scripts/03-season-management/send-renew-invites.js',
        command: 'node scripts/03-season-management/send-renew-invites.js <renew-groups.csv> [--subject="..."] [--season=...] [--deadline=ISO] [--venue=...] [--dry]',
        automation: {
          taskId: 'season.send-renew-invites',
          defaultDryRun: true
        },
        allowArgs: true,
        description: 'Sends renewal invitation emails using the automation job runner (supports dry-run).',
        notes: [
          'Dry-run activé par défaut depuis l’interface ; décochez pour envoyer réellement.',
          'Le CSV doit contenir les colonnes email, renewUrl, firstName/lastName et optionnellement seats.'
        ],
        templates: ['data_references/csv/renew-groups.template.csv'],
        form: {
          fields: [
            {
              name: 'csv',
              label: 'CSV destinataires',
              placeholder: 'renew-groups.csv',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'subject',
              label: 'Objet (optionnel)',
              placeholder: 'Renouvellement d’abonnement',
              arg: { type: 'option', template: '--subject=${value}' }
            },
            {
              name: 'season',
              label: 'Code saison (optionnel)',
              placeholder: '2025-2026',
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'deadline',
              label: 'Date limite (optionnel)',
              type: 'datetime',
              hint: 'Heure locale ; le décalage horaire est ajouté automatiquement.',
              placeholder: '2025-08-31T23:00:00Z',
              arg: { type: 'option', template: '--deadline=${value}' }
            }
          ]
        }
      },
      {
        id: 'export-renew-seats',
        label: 'Export Renewal Seats',
        order: 3,
        path: 'scripts/03-season-management/export-renew-seats.js',
        command: 'node scripts/03-season-management/export-renew-seats.js <seasonCode> --venue=<slug> --out=<file.csv>',
        run: {
          script: 'scripts/03-season-management/export-renew-seats.js',
          args: []
        },
        description: 'Exports the list of seats involved in the renewal campaign for auditing.',
        notes: [
          'Supports filters (--email, --group) and token expiration via --expires (ex: 30d).',
          'Fichier généré dans data/outputs (nom par défaut basé sur la saison).'
        ],
        templates: ['data_references/csv/renew-seats.template.csv'],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'base',
              label: 'URL de base (optionnel)',
              placeholder: 'https://billetterie.example/bts',
              arg: { type: 'option', template: '--base=${value}' }
            },
            {
              name: 'expires',
              label: 'Expiration des tokens (optionnel)',
              placeholder: '30d',
              arg: { type: 'option', template: '--expires=${value}' }
            },
            {
              name: 'out',
              label: 'Fichier de sortie (optionnel)',
              placeholder: 'renew-seats.csv',
              arg: { type: 'option', template: '--out=${value}' }
            },
            {
              name: 'sort',
              label: 'Tri (group|email)',
              placeholder: 'group',
              arg: { type: 'option', template: '--sort=${value}' }
            },
            {
              name: 'email',
              label: 'Filtrer par email (optionnel)',
              placeholder: 'example@club.fr',
              arg: { type: 'option', template: '--email=${value}' }
            },
            {
              name: 'group',
              label: 'Filtrer par groupKey (optionnel)',
              placeholder: 'group-key',
              arg: { type: 'option', template: '--group=${value}' }
            }
          ]
        }
      },

    ]
  },
  {
    id: '01-venue-management',
    label: '01 — Venue',
    order: 1,
    description: 'Register venues and keep their seating layout in sync with the database.',
    scripts: [
      {
        id: 'register-venue',
        label: 'Register Venue',
        order: 0,
        path: 'scripts/01-venue-management/register-venue.js',
        command: 'node scripts/01-venue-management/register-venue.js <slug> "<Venue Name>" [plan.svg] [--overwrite]',
        run: {
          script: 'scripts/01-venue-management/register-venue.js',
          args: []
        },
        description: 'Creates or updates the venue document with the provided slug and display name. Add --overwrite to replace an existing SVG plan.',
        templates: ['data_references/files/plan.svg'],
        form: {
          fields: [
            {
              name: 'slug',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'name',
              label: 'Nom du lieu',
              placeholder: 'Patinoire de Blagnac',
              required: true,
              arg: { type: 'positional', index: 1 }
            },
            {
              name: 'plan',
              label: 'Plan SVG (optionnel)',
              placeholder: 'data/inputs/plan.svg',
              hint: 'Copié dans public/dynamic/venues/<slug>/plan.svg si fourni.',
              arg: { type: 'positional', index: 2, optional: true }
            }
          ]
        }
      },
      {
        id: 'import-seats',
        label: 'Import Seats',
        order: 2,
        path: 'scripts/01-venue-management/import-seats.js',
        command: 'node scripts/01-venue-management/import-seats.js --venue=<slug> [--csv=<path/to/seats.csv>] [--view=<viewSlug>]',
        run: {
          script: 'scripts/01-venue-management/import-seats.js',
          args: []
        },
        description: 'Parses the venue plan SVG (under public/dynamic/venues/<slug>/plan.svg) and stores seats in the catalog. Optionally merge overrides from a CSV mapping (seatId, zoneKey, row, number). When --view is provided, the matching view is also enriched with seat attributes.',
        templates: [
          'data_references/csv/seats.template.csv'
        ],
        form: {
          fields: [
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'csv',
              label: 'CSV overrides (optionnel)',
              placeholder: 'data/inputs/seats.csv',
              arg: { type: 'option', template: '--csv=${value}' }
            },
            {
              name: 'view',
              label: 'Vue à enrichir (optionnel)',
              placeholder: 'main',
              hint: 'Slug de la vue présente dans public/dynamic/venues/<slug>/views/<vue>.svg.',
              arg: { type: 'option', template: '--view=${value}' }
            }
          ]
        }
      },
      {
        id: 'import-zones',
        label: 'Import Zones',
        order: 3,
        path: 'scripts/01-venue-management/import-zones.js',
        command: 'node scripts/01-venue-management/import-zones.js --venue=<slug> [--csv=<path/to/zones.csv>] [--view=<viewSlug>]',
        run: {
          script: 'scripts/01-venue-management/import-zones.js',
          args: []
        },
        description: 'Maintains the ZoneCatalog for a venue from CSV and/or the persisted SVG plan (data-zone-id by default) under public/dynamic/venues/<slug>/plan.svg. Instantiate zones per season afterwards. When --view is provided, the matching view is also enriched with zone attributes.',
        templates: ['data_references/csv/zones.template.csv'],
        form: {
          fields: [
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'csv',
              label: 'CSV zones (optionnel)',
              placeholder: 'data/inputs/zones.csv',
              arg: { type: 'option', template: '--csv=${value}' }
            },
            {
              name: 'view',
              label: 'Vue à enrichir (optionnel)',
              placeholder: 'main',
              hint: 'Slug de la vue présente dans public/dynamic/venues/<slug>/views/<vue>.svg.',
              arg: { type: 'option', template: '--view=${value}' }
            }
          ]
        }
      },
      {
        id: 'import-venue-view',
        label: 'Add View for Venue',
        order: 1,
        path: 'scripts/01-venue-management/import-venue-view.js',
        command: 'node scripts/01-venue-management/import-venue-view.js <venueSlug> <viewSlug> <path/to/view.svg> [--name="<label>"] [--overwrite]',
        run: {
          script: 'scripts/01-venue-management/import-venue-view.js',
          args: []
        },
        description: 'Copies a custom view to public/dynamic/venues/<slug>/views/<viewSlug>.svg. Optional display name is recorded in data/venue-views.json (not the SVG itself — no DB record either, kept as a simple sidecar so it can\'t drift out of sync with the file).',
        templates: ['data_references/files/plan.svg'],
        form: {
          fields: [
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'view',
              label: 'Slug de la vue',
              placeholder: 'cseairbus-view',
              required: true,
              arg: { type: 'positional', index: 1 }
            },
            {
              name: 'svg',
              label: 'Fichier SVG',
              placeholder: 'data/inputs/venue-view.svg',
              required: true,
              arg: { type: 'positional', index: 2 }
            },
            {
              name: 'viewName',
              label: 'Nom affiché (optionnel)',
              placeholder: 'Vue Partenaire AISC',
              arg: { type: 'option', template: '--name=${value}' }
            }
          ]
        }
      },
      {
        id: 'set-zone-meta',
        label: 'Set Zone Meta-Zone',
        order: 4,
        path: 'scripts/01-venue-management/set-zone-meta.js',
        command: 'node scripts/01-venue-management/set-zone-meta.js --venue=<slug> [--meta=<META> --zones=<A,B>] [--csv=<file>] [--season=<code>] [--clear] [--list]',
        run: {
          script: 'scripts/01-venue-management/set-zone-meta.js',
          args: []
        },
        description: 'Rattache des zones à une méta-zone : un regroupement logique de zones, qui n\'existe PAS sur le plan (aucun sélecteur SVG, aucun siège). Premier usage : la grille tarifaire s\'écrit UNE fois pour la méta-zone (colonne metaZone d\'Import Tariff Prices Catalog) au lieu d\'être recopiée zone par zone, et une zone rattachée plus tard hérite du prix sans retoucher la grille.',
        templates: ['data_references/csv/meta-zones.template.csv'],
        notes: [
          'La méta-zone décrit la SALLE : elle se pose sur le catalogue de zones du lieu, avant qu\'aucune saison n\'existe. Aucun code saison n\'est donc requis.',
          'Instantiate Venue For Season recopie ensuite la méta-zone sur les zones de la saison : les saisons créées après en héritent automatiquement.',
          'Le champ « Saison » ne sert qu\'à répercuter un changement sur une saison DÉJÀ instanciée, sans la réinstancier.',
          'Deux façons de faire : « Méta-zone » + « Zones » pour un groupe, ou un CSV (zoneKey,metaZone) pour poser tout un découpage d\'un coup.',
          'Laisser « Méta-zone » vide et cocher « Retirer » détache les zones visées ; dans un CSV, une cellule metaZone vide fait la même chose.',
          'Le regroupement ne sert pas qu\'aux prix : un bon cadeau peut être limité à une méta-zone (--zones=S_LOW), et il suit alors les zones rattachées ensuite.',
          'Une ligne de prix visant explicitement une zone l\'emporte sur sa méta-zone, tarif par tarif : on peut excepter S3/NORMAL sans détacher S3.',
          'Cocher « Lister » affiche le catalogue du lieu et ses méta-zones — sans rien écrire. Avec une saison, il montre aussi ses zones instanciées et les grilles définies par méta-zone.',
          'Une zone inconnue fait échouer le script : une faute de frappe rendrait la grille inopérante sans le dire.'
        ],
        form: {
          fields: [
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'stadium',
              required: true,
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'meta',
              label: 'Méta-zone (ex: S_LOW)',
              placeholder: 'S_LOW',
              arg: { type: 'option', template: '--meta=${value}' }
            },
            {
              name: 'zones',
              label: 'Zones visées (séparées par des virgules)',
              placeholder: 'S1,S3',
              arg: { type: 'option', template: '--zones=${value}' }
            },
            {
              name: 'season',
              label: 'Saison déjà instanciée à mettre à jour (optionnel)',
              placeholder: '2025-2026',
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'csv',
              label: 'CSV zoneKey,metaZone (alternative aux deux champs ci-dessus)',
              placeholder: 'data/inputs/meta-zones.csv',
              arg: { type: 'option', template: '--csv=${value}' }
            },
            {
              name: 'clear',
              label: 'Détacher les zones visées de leur méta-zone',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--clear' }
            },
            {
              name: 'list',
              label: 'Lister seulement (aucune écriture)',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--list' }
            }
          ]
        }
      }
    ]
  },
  {
    id: '02-tariff-management',
    label: '02 — Tariff',
    order: 2,
    description: 'Maintain the tariff catalog and zone-specific pricing matrices.',
    scripts: [
      {
        id: 'import-tariff-catalog',
        label: 'Import Tariff Catalog',
        order: 0,
        path: 'scripts/02-tariff-management/import-tariffs.js',
        command: 'node scripts/02-tariff-management/import-tariffs.js <path/to/tariff_catalog.csv>',
        run: {
          script: 'scripts/02-tariff-management/import-tariffs.js',
          args: []
        },
        description: 'Imports the master tariff catalog (code, label, justification requirements).',
        templates: ['data_references/csv/tariff-catalog.template.csv'],
        form: {
          fields: [
            {
              name: 'csv',
              label: 'CSV catalogue tarifs',
              placeholder: 'data/inputs/tariff_catalog.csv',
              required: true,
              arg: { type: 'positional', index: 0 }
            }
          ]
        }
      },
      {
        id: 'export-tariff-catalog',
        label: 'Export Tariff Catalog',
        order: 1,
        path: 'scripts/02-tariff-management/export-tariffs.js',
        command: 'node scripts/02-tariff-management/export-tariffs.js [--out=<tariff_catalog.csv>]',
        run: {
          script: 'scripts/02-tariff-management/export-tariffs.js',
          args: []
        },
        description: 'Exports the current tariff catalog (code, labels, requirements) to CSV.',
        notes: [
          'Default output is data/outputs/tariff_catalog.csv; override with --out.'
        ],
        form: {
          fields: [
            {
              name: 'out',
              label: 'Nom du fichier de sortie',
              placeholder: 'tariff_catalog.csv',
              arg: { type: 'option', template: '--out=${value}' }
            }
          ]
        }
      },
      {
        id: 'import-tariff-prices',
        label: 'Import Tariff Prices Catalog',
        order: 2,
        path: 'scripts/02-tariff-management/import-tariff-prices.js',
        command: 'node scripts/02-tariff-management/import-tariff-prices.js <catalogSlug> <path/to/prices.csv> [--venue=<slug>] [--format=list|matrix]',
        run: {
          script: 'scripts/02-tariff-management/import-tariff-prices.js',
          args: []
        },
        description: 'Loads reusable tariff prices (list CSV by default) that can later be instantiated for seasons or events.',
        notes: [
          'Un seul fichier pour tout : en-tête `zoneKey,metaZone,tariffCode,priceCents,partnerPriceCents,currency,channels`. Chaque ligne remplit SOIT zoneKey, SOIT metaZone — jamais les deux, jamais aucune.',
          'Une ligne zoneKey l\'emporte sur la méta-zone de cette zone, tarif par tarif : on peut tarifer tout un groupe puis excepter une zone.',
          'Les lignes commençant par # sont ignorées (commentaires du gabarit).',
          'Avec --venue, les zones et méta-zones du fichier sont vérifiées contre le catalogue du lieu : une méta-zone placée par erreur dans la colonne zoneKey interrompt l\'import.',
          'Supports list and matrix CSV formats; override detection with --format=list|matrix.',
          'Use --venue=<slug> to scope prices to a specific arena; omit to keep them global.'
        ],
        templates: ['data_references/csv/tariff-prices.template.csv'],
        form: {
          fields: [
            {
              name: 'catalog',
              label: 'Slug du catalogue',
              placeholder: 'season-game',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'csv',
              label: 'CSV tarifs',
              placeholder: 'data/inputs/tariff-prices.csv',
              required: true,
              arg: { type: 'positional', index: 1 }
            },
            {
              name: 'venue',
              label: 'Lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'format',
              label: 'Format explicite (optionnel)',
              placeholder: 'list',
              arg: { type: 'option', template: '--format=${value}' },
              options: [
                { label: 'Auto (détection)', value: '' },
                { label: 'Liste', value: 'list' },
                { label: 'Matrice', value: 'matrix' }
              ]
            }
          ]
        }
      },
      {
        id: 'export-zone-tariffs',
        label: 'Export Zone Tariffs',
        order: 3,
        path: 'scripts/02-tariff-management/export-zone-tariffs.js',
        command: 'node scripts/02-tariff-management/export-zone-tariffs.js <seasonCode> <venueSlug> --out=<file.csv>',
        run: {
          script: 'scripts/02-tariff-management/export-zone-tariffs.js',
          args: []
        },
        description: 'Exports the price matrix for verification or sharing.',
        notes: [
          'Default filename is prices.csv; override with --out=<file>. Les exports sont déposés dans data/outputs.'
        ],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'positional', index: 1 }
            },
            {
              name: 'out',
              label: 'Nom du fichier de sortie',
              placeholder: 'prices.csv',
              arg: { type: 'option', template: '--out=${value}' }
            }
          ]
        }
      },
      {
        id: 'export-zone-tariffs-matrix',
        label: 'Export Tariffs (matrix)',
        order: 6,
        path: 'scripts/02-tariff-management/export-zone-tariffs-matrix.js',
        command: 'node scripts/02-tariff-management/export-zone-tariffs-matrix.js <seasonCode> <venueSlug> [outCsvPath]',
        run: {
          script: 'scripts/02-tariff-management/export-zone-tariffs-matrix.js',
          args: []
        },
        description: 'Produces a tariffCode × zone matrix (euros) to ease comparisons.',
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'positional', index: 1 }
            },
            {
              name: 'out',
              label: 'Fichier de sortie (optionnel)',
              placeholder: 'zone-tariffs.csv',
              arg: { type: 'positional', index: 2, optional: true }
            }
          ]
        }
      },
      {
        id: 'clone-zone-tariffs',
        label: 'Clone Zone Tariffs',
        order: 6,
        path: 'scripts/02-tariff-management/clone-zone-tariffs.mjs',
        command: 'node scripts/02-tariff-management/clone-zone-tariffs.mjs --season=<code> --venue=<slug> --from-zone=<A1> --to-zones=<B1,B2> [--discount=30]',
        run: {
          script: 'scripts/02-tariff-management/clone-zone-tariffs.mjs',
          args: []
        },
        description: 'Copies pricing from one zone to others, optionally applying a discount.',
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'venue',
              label: 'Slug du lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'fromZone',
              label: 'Zone source',
              placeholder: 'A1',
              required: true,
              arg: { type: 'option', template: '--from-zone=${value}' }
            },
            {
              name: 'toZones',
              label: 'Zones cibles (séparées par des virgules)',
              placeholder: 'TBH7,TBH7-VIRAGE',
              required: true,
              arg: { type: 'option', template: '--to-zones=${value}' }
            },
            {
              name: 'discount',
              label: 'Remise (%) optionnelle',
              placeholder: '30',
              arg: { type: 'option', template: '--discount=${value}' }
            }
          ]
        }
      },
      {
        id: 'remove-price-catalog',
        label: 'Remove Price Catalog',
        order: 99,
        path: 'scripts/02-tariff-management/remove-price-catalog.js',
        command: 'node scripts/02-tariff-management/remove-price-catalog.js --catalog=<slug> [--venue=<slug>] --force',
        run: {
          script: 'scripts/02-tariff-management/remove-price-catalog.js',
          args: ['--force']
        },
        description: 'Deletes TariffPriceCatalog rows for a catalogSlug (+ optional venue). Safe by construction: instantiate-tariffs.js copies rows once and never links back, so this can never retroactively affect an event/season that already instantiated from it — only future instantiation from this slug fails until recreated.',
        danger: true,
        notes: [
          'Leave venue blank to remove every venue scope for this catalogSlug (global + all venue-specific overrides); set it to remove just one venue\'s rows.',
          'Run the equivalent CLI command with --dry-run first to see the exact rows/zones/tariffs/price range before confirming here.'
        ],
        form: {
          fields: [
            {
              name: 'catalog',
              label: 'catalogSlug à supprimer',
              placeholder: 'event_p01',
              required: true,
              arg: { type: 'option', template: '--catalog=${value}' }
            },
            {
              name: 'venue',
              label: 'Lieu (optionnel — vide = toutes les portées)',
              placeholder: 'stadium',
              arg: { type: 'option', template: '--venue=${value}' }
            }
          ]
        }
      }
    ]
  },
  {
    id: '02-ticket-ad-management',
    label: '02 — Ticket/Ad',
    // Shares the "02" number with Tariff, same insertion technique as
    // 01 Organization/01 Venue: 02 Tariff (2) > 02 Ticket/Ad (2.5) > 03 Season (3).
    order: 2.5,
    description: 'Ticket templates and the advertising content (images, text, promo QR) placed on them based on a ticket\'s own tariffCode/zoneKey/zoneType.',
    scripts: [
      {
        id: 'import-templates',
        label: 'Import Email/Ticket Template',
        order: 0,
        path: 'scripts/00-system-management/import-templates.js',
        command: 'node scripts/00-system-management/import-templates.js --resource=<email|ticket|logo> --file=<path> [--kind=<kind>] [--theme=<name>]',
        run: {
          script: 'scripts/00-system-management/import-templates.js',
          args: []
        },
        description: 'Imports a single email or ticket template file (any filename — no naming convention required) as the given kind, with an optional theme variant — or stages a logo asset into data/assets/. Delegates to set-email-template.js / set-ticket-template.js, so the same validation/diff preview applies.',
        templates: ['data_references/README.md'],
        notes: [
          'Email/Ticket: pick the resource, kind, and (optionally) theme explicitly; nothing is inferred from the filename.',
          'kind options combine both resources\' known values; a kind that doesn\'t apply to the chosen resource (e.g. "renew" for a ticket) is still accepted but flagged as unreachable — same behavior as running set-*-template.js directly.',
          'theme is free text — any name (e.g. halloween, partner01) — and must match a "theme" customization key for it to actually be selected at send time.',
          'Logo: just copies the file into data/assets/ — kind/theme are ignored. Staging the file alone changes nothing; set the "logo" customization key (e.g. via set-partner-custo.js) to "assets/<filename>" so a ticket actually picks it up, same mechanism as "theme".',
          'Use --dry-run to preview without writing files.'
        ],
        form: {
          fields: [
            {
              name: 'resource',
              label: 'Type',
              required: true,
              arg: { type: 'option', template: '--resource=${value}' },
              options: [
                { label: 'Email', value: 'email' },
                { label: 'Ticket', value: 'ticket' },
                { label: 'Logo (ticket asset)', value: 'logo' }
              ]
            },
            {
              name: 'kind',
              label: 'Kind (ignoré pour Logo)',
              arg: { type: 'option', template: '--kind=${value}' },
              options: [
                { label: 'renew', value: 'renew' },
                { label: 'subscription', value: 'subscription' },
                { label: 'event', value: 'event' },
                { label: 'public', value: 'public' },
                { label: 'default (ticket only)', value: 'default' }
              ]
            },
            {
              name: 'file',
              label: 'Fichier source',
              placeholder: 'data/inputs/mon-fichier.html',
              required: true,
              arg: { type: 'option', template: '--file=${value}' }
            },
            {
              name: 'theme',
              label: 'Thème (optionnel, texte libre, ignoré pour Logo)',
              placeholder: 'halloween, partner01...',
              arg: { type: 'option', template: '--theme=${value}' }
            }
          ]
        }
      },
      {
        id: 'set-ad-campaign',
        label: 'Set Ad Campaign (identity)',
        order: 1,
        path: 'scripts/02-ticket-ad-management/set-ad-campaign.js',
        command: 'node scripts/02-ticket-ad-management/set-ad-campaign.js --slug=<slug> [--target-url=<url>] [--label="<text>"] [--active=true|false]',
        run: {
          script: 'scripts/02-ticket-ad-management/set-ad-campaign.js',
          args: []
        },
        description: 'Defines (or edits) a sponsor campaign\'s identity: label, click target, active. Pure metadata — no asset here, see Import Ad Campaign Asset below for that. Neither script is a prerequisite for the other: register a campaign here first (no image on tickets until an asset is attached), or let Import Ad Campaign Asset create it directly.',
        notes: [
          'Use --dry-run to preview without writing.'
        ],
        form: {
          fields: [
            {
              name: 'slug',
              label: 'Identité de la campagne (créée si absente)',
              placeholder: 'sponsor-x-2026',
              required: true,
              arg: { type: 'option', template: '--slug=${value}' }
            },
            {
              name: 'targetUrl',
              label: 'Lien sponsor (QR promo, optionnel)',
              placeholder: 'https://sponsor-x.example/offer',
              arg: { type: 'option', template: '--target-url=${value}' }
            },
            {
              name: 'label',
              label: 'Nom affiché (optionnel)',
              placeholder: 'Sponsor X — VIP',
              arg: { type: 'option', template: '--label=${value}' }
            }
          ]
        }
      },
      {
        id: 'import-ad-campaign-asset',
        label: 'Import Ad Campaign Asset',
        order: 2,
        path: 'scripts/02-ticket-ad-management/import-ad-campaign-asset.js',
        command: 'node scripts/02-ticket-ad-management/import-ad-campaign-asset.js --file=<path> --slug=<asset-id> [--campaign=<campaign-slug>] [--kind=svg|raster] [--dry-run]',
        run: {
          script: 'scripts/02-ticket-ad-management/import-ad-campaign-asset.js',
          args: []
        },
        description: 'Stages a sponsor asset into data/assets/ads/ under a manually-chosen id, and optionally attaches it to a campaign — creating that campaign if it doesn\'t exist yet. A single svg/png/jpg stages one asset; a .zip stages a whole FAMILY (a "carousel") — tickets rotate through every image inside by their position within the order.',
        notes: [
          'Slug is the asset\'s own identity (manual, not derived from the filename) — lets you keep several versions/families (banner-v1, banner-v2, ...) and pick which one a campaign uses.',
          'Leave "campaign" empty to just stage the asset ("global"/unattached) — attach it later by re-running with the same slug and --campaign set; the file is then optional (reuses what\'s already staged).',
          'A .zip must contain only one asset kind (all svg or all raster) — mixed zips are rejected.',
          '--kind is inferred from the file extension when omitted (ignored for a zip).'
        ],
        form: {
          fields: [
            {
              name: 'slug',
              label: 'Identité de l\'asset (manuelle)',
              placeholder: 'sponsor-x-banner-v1',
              required: true,
              arg: { type: 'option', template: '--slug=${value}' }
            },
            {
              name: 'file',
              label: 'Fichier asset (svg, png, jpg) ou famille (.zip) — optionnel si déjà en place',
              placeholder: 'data/inputs/sponsor-x-banner.png',
              arg: { type: 'option', template: '--file=${value}' }
            },
            {
              name: 'campaign',
              label: 'Campagne à attacher (optionnel — vide = non attaché)',
              placeholder: 'sponsor-x-2026',
              arg: { type: 'option', template: '--campaign=${value}' }
            }
          ]
        }
      },
      {
        id: 'import-ad-campaign-catalog',
        label: 'Import Ad Campaign Catalog',
        order: 2.5,
        path: 'scripts/02-ticket-ad-management/import-ad-campaign-catalog.js',
        command: 'node scripts/02-ticket-ad-management/import-ad-campaign-catalog.js <catalogSlug> <path/to/ad-campaign-catalog.csv> [--venue=<slug>] [--append] [--dry-run]',
        run: {
          script: 'scripts/02-ticket-ad-management/import-ad-campaign-catalog.js',
          args: []
        },
        description: 'Imports a reusable ad campaign catalog — WHERE/WHEN an existing campaign (by slug, see Import Ad Campaign Asset) shows up: which slot, what kind of content (image/qr/text), filtered by tariffCode/zoneKey/zoneType — that can later be instantiated for a season or event.',
        notes: [
          'contentType is image, qr, or text — see the CSV template for what "slot" means for each and how qrValue/text work.',
          'By default clears existing entries for the same catalogSlug/venue before import — use --append to upsert without clearing.',
          'Warns (but doesn\'t fail) if a campaignSlug isn\'t defined yet.'
        ],
        templates: ['data_references/csv/ad-campaign-catalog.template.csv'],
        form: {
          fields: [
            {
              name: 'catalog',
              label: 'Slug du catalogue',
              placeholder: 'sponsors-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'csv',
              label: 'CSV campagnes',
              placeholder: 'data/inputs/ad-campaign-catalog.csv',
              required: true,
              arg: { type: 'positional', index: 1 }
            },
            {
              name: 'venue',
              label: 'Lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            }
          ]
        }
      },
      {
        id: 'export-ad-campaign-catalog',
        label: 'Export Ad Campaign Catalog',
        order: 3,
        path: 'scripts/02-ticket-ad-management/export-ad-campaign-catalog.js',
        command: 'node scripts/02-ticket-ad-management/export-ad-campaign-catalog.js <catalogSlug> [--venue=<slug>] [--out=<file.csv>]',
        run: {
          script: 'scripts/02-ticket-ad-management/export-ad-campaign-catalog.js',
          args: []
        },
        description: 'Exports an ad campaign catalog to CSV for review or editing.',
        notes: [
          'Default output is data/outputs/ad-campaign-catalog-<catalogSlug>.csv; override with --out.'
        ],
        form: {
          fields: [
            {
              name: 'catalog',
              label: 'Slug du catalogue',
              placeholder: 'sponsors-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'venue',
              label: 'Lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'out',
              label: 'Nom du fichier de sortie',
              placeholder: 'ad-campaign-catalog.csv',
              arg: { type: 'option', template: '--out=${value}' }
            }
          ]
        }
      },
      {
        id: 'remove-ad-campaign-catalog',
        label: 'Remove Ad Campaign Catalog',
        order: 98,
        path: 'scripts/02-ticket-ad-management/remove-ad-campaign-catalog.js',
        command: 'node scripts/02-ticket-ad-management/remove-ad-campaign-catalog.js --catalog=<slug> [--venue=<slug>] --force',
        run: {
          script: 'scripts/02-ticket-ad-management/remove-ad-campaign-catalog.js',
          args: ['--force']
        },
        description: 'Deletes AdCampaignCatalog rows for a catalogSlug (+ optional venue). Safe by construction: instantiate-ad-campaigns.js copies rows once and never links back, so this can never retroactively affect a season/event that already instantiated from it — only future instantiation from this slug fails until recreated. Does not touch AdCampaign masters.',
        danger: true,
        notes: [
          'Leave venue blank to remove every venue scope for this catalogSlug (global + all venue-specific overrides); set it to remove just one venue\'s rows.',
          'Run the equivalent CLI command with --dry-run first to see the exact rows before confirming here.'
        ],
        form: {
          fields: [
            {
              name: 'catalog',
              label: 'catalogSlug à supprimer',
              placeholder: 'sponsors-2026',
              required: true,
              arg: { type: 'option', template: '--catalog=${value}' }
            },
            {
              name: 'venue',
              label: 'Lieu (optionnel — vide = toutes les portées)',
              placeholder: 'stadium',
              arg: { type: 'option', template: '--venue=${value}' }
            }
          ]
        }
      },
      {
        id: 'remove-ad-campaign',
        label: 'Remove Ad Campaign',
        order: 99,
        path: 'scripts/02-ticket-ad-management/remove-ad-campaign.js',
        command: 'node scripts/02-ticket-ad-management/remove-ad-campaign.js --slug=<slug> --force',
        run: {
          script: 'scripts/02-ticket-ad-management/remove-ad-campaign.js',
          args: ['--force']
        },
        description: 'Deletes an AdCampaign master (identity/asset/targetUrl) by slug, and its staged asset file under data/assets/ads/ (kept if another campaign still references the same file). Does not touch campaign catalogs or instantiated placements referencing it — they simply stop resolving an asset until the campaign is recreated.',
        danger: true,
        form: {
          fields: [
            {
              name: 'slug',
              label: 'Identité de la campagne à supprimer',
              placeholder: 'sponsor-x-2026',
              required: true,
              arg: { type: 'option', template: '--slug=${value}' }
            }
          ]
        }
      }
    ]
  },
  {
    id: '03-season-management',
    label: '03 — Season',
    order: 3,
    description: 'Season setup tasks (data seeding, subscriber imports, seat provisioning).',
    scripts: [
      {
        id: 'create-season',
        label: 'Create Season',
        order: 0,
        path: 'scripts/03-season-management/create-season.js',
        command: 'node scripts/03-season-management/create-season.js <seasonCode> --name="<Display Name>" [--active=true]',
        run: {
          script: 'scripts/03-season-management/create-season.js',
          args: []
        },
        description: 'Creates or updates a season document (code/name/active). Configure phases separately.',
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'name',
              label: 'Nom affiché (optionnel)',
              placeholder: 'Saison 2025-2026',
              arg: { type: 'option', template: '--name=${value}' }
            },
            {
              name: 'active',
              label: 'Activer la saison (true/false)',
              placeholder: 'true',
              arg: { type: 'option', template: '--active=${value}' }
            }
          ]
        }
      },
      {
        id: 'publish-season',
        label: 'Publish Season (renew / subscribe)',
        order: 0.1,
        path: 'scripts/03-season-management/publish-season.js',
        command: 'node scripts/03-season-management/publish-season.js --season=<code> [--activity=<state>] [--renew=<state>] [--subscribe=<state>] [--show]',
        run: {
          script: 'scripts/03-season-management/publish-season.js',
          args: []
        },
        description: 'Ouvre ou ferme les portes de vente d\'une saison (renouvellement, abonnement public) et son état de publication. Pendant de « Publish Event » pour les matchs.',
        notes: [
          'Une saison a plusieurs portes qui ne bougent pas ensemble : fermer le renouvellement pendant que la vente publique tourne est le cas courant. Chaque porte a donc son état, on ne pilote que celles qu\'on nomme.',
          'activity=active est nécessaire pour que QUOI QUE CE SOIT soit accessible : une porte ouverte sur une saison en brouillon ne montre rien. Le script prévient si les deux se contredisent.',
          'Les portes servent /season/<code>/renew et /season/<code>/subscribe. Les anciens liens /renew?id= restent servis : ils redirigent vers le chemin explicite.',
          'Remplace `set-season-phases.js` (dont le middleware n\'a jamais été monté), `enableRenewal` (écrit, jamais lu) et la notion de « saison active » basée sur un champ inexistant.',
          'Cocher « Afficher » lit l\'état courant sans rien écrire.'
        ],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'activity',
              label: 'Publication (optionnel)',
              arg: { type: 'option', template: '--activity=${value}' },
              options: [
                { label: '— (ne pas changer)', value: '' },
                { label: 'Brouillon', value: 'draft' },
                { label: 'Active', value: 'active' },
                { label: 'Archivée', value: 'archived' }
              ]
            },
            {
              name: 'renew',
              label: 'Renouvellement (optionnel)',
              arg: { type: 'option', template: '--renew=${value}' },
              options: [
                { label: '— (ne pas changer)', value: '' },
                { label: 'Pas encore ouvert', value: 'notopen' },
                { label: 'Ouvert', value: 'open' },
                { label: 'Clos', value: 'closed' }
              ]
            },
            {
              name: 'subscribe',
              label: 'Abonnement public (optionnel)',
              arg: { type: 'option', template: '--subscribe=${value}' },
              options: [
                { label: '— (ne pas changer)', value: '' },
                { label: 'Pas encore ouvert', value: 'notopen' },
                { label: 'Ouvert', value: 'open' },
                { label: 'Clos', value: 'closed' }
              ]
            },
            {
              name: 'show',
              label: 'Afficher l\'état courant (sans rien changer)',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--show' }
            }
          ]
        }
      },

      {
        id: 'set-season-custo',
        label: 'Set Season Customization',
        order: 0.3,
        path: 'scripts/03-season-management/set-season-custo.js',
        command: 'node scripts/03-season-management/set-season-custo.js --season=<code> --file=<customization.json>',
        run: {
          script: 'scripts/03-season-management/set-season-custo.js',
          args: []
        },
        description: 'Stores season-level UI/email customization keys under data/customization/seasons/<code>.json.',
        templates: ['data/customization/seasons/<code>.json'],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'file',
              label: 'JSON customization',
              placeholder: 'data/customization/seasons/<code>.json',
              required: true,
              arg: { type: 'option', template: '--file=${value}' }
            }
          ]
        }
      },
      {
        id: 'instantiate-venue-for-season',
        label: 'Instantiate Venue for Season',
        order: 1,
        path: 'scripts/03-season-management/instantiate-venue-for-season.js',
        command: 'node scripts/03-season-management/instantiate-venue-for-season.js <seasonCode> <venueSlug> [--skip-seats] [--skip-zones]',
        run: {
          script: 'scripts/03-season-management/instantiate-venue-for-season.js',
          args: []
        },
        description: 'Clones seat and zone catalogs into season-specific collections. Use the skip flags to target only seats or zones.',
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'positional', index: 1 }
            }
          ]
        }
      },
      {
        id: 'instantiate-tariffs',
        label: 'Instantiate Tariffs for Season',
        order: 2,
        path: 'scripts/03-season-management/instantiate-tariffs.js',
        command: 'node scripts/03-season-management/instantiate-tariffs.js <seasonCode> <venueSlug> --catalog=<slug[,slug2]>',
        run: {
          script: 'scripts/03-season-management/instantiate-tariffs.js',
          args: []
        },
        description: 'Applies one or more tariff matrix catalogs to populate TariffPrice for the season/venue. Add --clear to purge existing rows first.',
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'positional', index: 1 }
            },
            {
              name: 'catalog',
              label: 'Catalogues (slug[,slug2])',
              placeholder: 'season-game',
              required: true,
              arg: { type: 'option', template: '--catalog=${value}' }
            }
          ]
        }
      },
      {
        id: 'season-instantiate-ad-campaigns',
        label: 'Instantiate Ad Campaigns for Season',
        order: 2.2,
        path: 'scripts/03-season-management/instantiate-ad-campaigns.js',
        command: 'node scripts/03-season-management/instantiate-ad-campaigns.js <seasonCode> <venueSlug> --catalog=<slug[,slug2]> [--clear] [--dry-run] [--set-theme=<value>]',
        run: {
          script: 'scripts/03-season-management/instantiate-ad-campaigns.js',
          args: []
        },
        description: 'Applies one or more ad campaign catalogs as the season-wide default for tickets that don\'t have an event-specific placement (e.g. subscription/public tickets). Add --clear to purge existing rows first.',
        notes: [
          'Set "theme" to also switch this season\'s ticket/email to the matching themed template (see Set Season Theme) — optional, leave blank to only instantiate the placements.'
        ],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'positional', index: 1 }
            },
            {
              name: 'catalog',
              label: 'Catalogues (slug[,slug2])',
              placeholder: 'sponsors-2026',
              required: true,
              arg: { type: 'option', template: '--catalog=${value}' }
            },
            {
              name: 'theme',
              label: 'Thème à appliquer (optionnel)',
              placeholder: 'ads',
              arg: { type: 'option', template: '--set-theme=${value}' }
            }
          ]
        }
      },
      {
        id: 'set-season-theme',
        label: 'Set Season Theme',
        order: 2.3,
        path: 'scripts/03-season-management/set-season-theme.js',
        command: 'node scripts/03-season-management/set-season-theme.js --season=<code> [--theme=<value>|--clear] [--dry-run]',
        run: {
          script: 'scripts/03-season-management/set-season-theme.js',
          args: []
        },
        description: 'Sets (or clears) Season.templateTheme — an explicit override checked before the customization-layered "theme" key, driving both the ticket PDF and confirmation email for subscription/public orders in this season.',
        notes: [
          'A theme only does anything once a matching file exists (tickets/<file>.<theme>.svg and/or email/<file>.<theme>.html) — see Set Ticket Template / Set Email Template with --theme=.'
        ],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'theme',
              label: 'Thème (vide + effacer = retombe sur la customization)',
              placeholder: 'ads',
              arg: { type: 'option', template: '--theme=${value}' }
            },
            {
              name: 'clear',
              label: 'Effacer le thème',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--clear' }
            }
          ]
        }
      },
      {
        id: 'import-subscription-orders',
        label: 'Import Subscription Orders',
        order: 4,
        path: 'scripts/03-season-management/import-subscription-orders.js',
        command: 'node scripts/03-season-management/import-subscription-orders.js <path/to/orders.csv> [--season=...] [--venue=...] [--status=paid] [--commit] [--force] [--sendEmails]',
        run: {
          script: 'scripts/03-season-management/import-subscription-orders.js',
          args: []
        },
        description: 'Re-import subscription orders exported from the system. Dry-run by default; add --commit to apply changes.',
        templates: ['data_references/csv/orders-export.template.csv'],
        form: {
          fields: [
            {
              name: 'csv',
              label: 'CSV commandes',
              placeholder: 'data/inputs/subscription-orders.csv',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'season',
              label: 'Code saison (optionnel)',
              placeholder: '2025-2026',
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'venue',
              label: 'Slug du lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'status',
              label: 'Statut (optionnel)',
              placeholder: 'paid',
              arg: { type: 'option', template: '--status=${value}' }
            }
          ]
        }
      },
      {
        id: 'export-subscribers',
        label: 'Export Renewers',
        order: 5,
        path: 'scripts/03-season-management/export-subscribers.js',
        command: 'node scripts/03-season-management/export-subscribers.js --season=<code> [--venue=...] [--activeOnly]',
        run: {
          script: 'scripts/03-season-management/export-subscribers.js',
          args: []
        },
        description: 'Exports the renewer registry (formerly Subscribers collection) for the requested season/venue.',
        templates: ['data_references/csv/subscribers-export.template.csv'],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Season code',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'venue',
              label: 'Venue slug (optional)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            },
          ]
        }
      },
      {
        id: 'export-subscription-orders',
        label: 'Export Subscription Orders',
        order: 7,
        path: 'scripts/03-season-management/export-subscription-orders.js',
        command: 'node scripts/03-season-management/export-subscription-orders.js [--season=...] [--venue=...] [--status=paid]',
        run: {
          script: 'scripts/03-season-management/export-subscription-orders.js',
          args: []
        },
        description: 'Exports orders with phase=subscription. Useful to audit new season sales.',
        templates: ['data_references/csv/orders-export.template.csv'],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison (optionnel)',
              placeholder: '2025-2026',
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'venue',
              label: 'Slug du lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'status',
              label: 'Statut (optionnel)',
              placeholder: 'paid',
              arg: { type: 'option', template: '--status=${value}' }
            }
          ]
        }
      },
      {
        id: 'block-free-seats-for-season',
        label: 'Block/Free Seats for Season',
        order: 7,
        path: 'scripts/03-season-management/block-free-seats-for-season.js',
        command: 'node scripts/03-season-management/block-free-seats-for-season.js --file=<holds.csv> [--season=...] [--venue=...] [--commit] [--force]',
        run: {
          script: 'scripts/03-season-management/block-free-seats-for-season.js',
          args: []
        },
        description: 'Blocks or frees season seats (status busy) based on a CSV; accepts seatId, seatPattern (regex), or zoneKey.',
        notes: [
          'Runs in dry-run by default; add --commit to persist and --force to override non-held seats.'
        ],
        templates: ['data_references/csv/seats-hold-release.template.csv'],
        form: {
          fields: [
            {
              name: 'file',
              label: 'CSV seats',
              placeholder: 'data/inputs/season-blocks.csv',
              required: true,
              arg: { type: 'option', template: '--file=${value}' }
            },
            {
              name: 'season',
              label: 'Code saison (optionnel)',
              placeholder: '2025-2026',
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'venue',
              label: 'Slug du lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            }
          ]
        }
      },
      {
        id: 'remove-season-tariffs',
        label: 'Remove Season Tariffs',
        order: 99,
        path: 'scripts/03-season-management/remove-season-tariffs.js',
        command: 'node scripts/03-season-management/remove-season-tariffs.js --season=<code> --venue=<slug> --force',
        run: {
          script: 'scripts/03-season-management/remove-season-tariffs.js',
          args: ['--force']
        },
        description: 'Deletes the instantiated season-scoped TariffPrice rows for a (season, venue) pair — subscription pricing. Refuses if the season is currently active unless explicitly overridden on the CLI (--allow-active-season, not exposed here) — deleting live subscription pricing needs a deliberate extra step, not just this confirmation.',
        danger: true,
        notes: [
          'Existing paid subscription orders keep their own captured prices regardless — this only affects new purchases going forward.',
          'Run the equivalent CLI command with --dry-run first to see row counts before confirming here.'
        ],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'option', template: '--venue=${value}' }
            }
          ]
        }
      },
      {
        id: 'remove-season-ad-campaigns',
        label: 'Remove Season Ad Campaigns',
        order: 99.5,
        path: 'scripts/03-season-management/remove-season-ad-campaigns.js',
        command: 'node scripts/03-season-management/remove-season-ad-campaigns.js --season=<code> --venue=<slug> --force',
        run: {
          script: 'scripts/03-season-management/remove-season-ad-campaigns.js',
          args: ['--force']
        },
        description: 'Deletes the instantiated season-scoped AdCampaignPlacement rows for a (season, venue) pair. Does not touch AdCampaign masters or the AdCampaignCatalog template.',
        danger: true,
        notes: [
          'Run the equivalent CLI command with --dry-run first to see row counts before confirming here.'
        ],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'option', template: '--venue=${value}' }
            }
          ]
        }
      }
    ]
  },
  {
    id: '04-event-management',
    label: '04 — Event',
    order: 4,
    description: 'Create events, configure their sales windows, and manage ancillary assets (QR banks, PDFs…).',
    scripts: [
      {
        id: 'event-create',
        label: 'Create Event',
        order: 0,
        path: 'scripts/04-event-management/create.js',
        command: 'node scripts/04-event-management/create.js --slug=<eventCode> --name="<Event Name>" --date=YYYY-MM-DDThh:mm:ssZ --season=<code>',
        run: {
          script: 'scripts/04-event-management/create.js',
          args: []
        },
        description: 'Creates a new event bound to a season; attach venue/plan later via Instantiate Venue for Event.',
        notes: [
          'The script auto-generates priceTableKey=ev:<slug>; adjust afterwards if you need an existing table.'
        ],
        form: {
          fields: [
            {
              name: 'slug',
              label: 'Slug de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--slug=${value}' }
            },
            {
              name: 'name',
              label: 'Nom affiché',
              placeholder: 'Bélougas vs Vipers',
              required: true,
              arg: { type: 'option', template: '--name=${value}' }
            },
            {
              name: 'date',
              label: 'Date et heure du match',
              type: 'datetime',
              hint: 'Heure locale ; le décalage horaire est ajouté automatiquement.',
              placeholder: '2025-09-21T16:00:00+02:00',
              required: true,
              arg: { type: 'option', template: '--date=${value}' }
            },
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'desc',
              label: 'Description courte (optionnel)',
              placeholder: 'Match de saison régulière',
              arg: { type: 'option', template: '--desc=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-clone',
        label: 'Clone Event',
        order: 0.1,
        path: 'scripts/04-event-management/clone-event.js',
        command: 'node scripts/04-event-management/clone-event.js --from=<slug> --slug=<newSlug> --name="<New Name>" --date=YYYY-MM-DDThh:mm:ssZ',
        run: {
          script: 'scripts/04-event-management/clone-event.js',
          args: []
        },
        description: 'Creates a new event from an existing one: copies venue (seats/zones instantiated for the new event\'s season+venue), tariffs (the source event\'s actual Tariff/TariffPrice rows, preserving any manual tweaks), and the event customization file. The new event always starts sale=notopen, activity=draft with an empty QR bank.',
        templates: ['data/customization/events/<slug>.json'],
        notes: [
          'venueSlug/venueView are copied from the source event; season defaults to the source\'s season unless overridden.',
          'priceTableKey is always a fresh "ev:<newSlug>" — never shared with the source event.',
          'QR bank codes are never copied (one-shot, event-specific) — the new event starts with an empty bank.',
          'Review tariffs/customization and use Publish Event when ready — cloning does not open sales.'
        ],
        form: {
          fields: [
            {
              name: 'from',
              label: 'Événement source (slug ou ID)',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--from=${value}' }
            },
            {
              name: 'slug',
              label: 'Slug du nouvel événement',
              placeholder: 'match-2025-10-05-bts-vs-yyy',
              required: true,
              arg: { type: 'option', template: '--slug=${value}' }
            },
            {
              name: 'name',
              label: 'Nom affiché',
              placeholder: 'Bélougas vs Yankees',
              required: true,
              arg: { type: 'option', template: '--name=${value}' }
            },
            {
              name: 'date',
              label: 'Date et heure du match',
              type: 'datetime',
              hint: 'Heure locale ; le décalage horaire est ajouté automatiquement.',
              placeholder: '2025-10-05T16:00:00+02:00',
              required: true,
              arg: { type: 'option', template: '--date=${value}' }
            },
            {
              name: 'season',
              label: 'Code saison (optionnel — sinon celui de la source)',
              placeholder: '2025-2026',
              arg: { type: 'option', template: '--season=${value}' }
            }
          ]
        }
      },
      {
        id: 'set-event-custo',
        label: 'Set Event Customization',
        order: 0.3,
        path: 'scripts/04-event-management/set-event-custo.js',
        command: 'node scripts/04-event-management/set-event-custo.js --event=<slug> --file=<customization.json>',
        run: {
          script: 'scripts/04-event-management/set-event-custo.js',
          args: []
        },
        description: 'Stores event-level UI/email customization keys under data/customization/events/<slug>.json.',
        templates: ['data/customization/events/<slug>.json'],
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'file',
              label: 'JSON customization',
              placeholder: 'data/customization/events/<slug>.json',
              required: true,
              arg: { type: 'option', template: '--file=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-instantiate-venue',
        label: 'Instantiate Venue for Event',
        order: 0.5,
        path: 'scripts/04-event-management/instantiate-venue-for-event.js',
        command: 'node scripts/04-event-management/instantiate-venue-for-event.js --event=<slug|ObjectId> [--venue=<slug>] [--skip-seats] [--skip-zones] [--venue-view=<slug>]',
        run: {
          script: 'scripts/04-event-management/instantiate-venue-for-event.js',
          args: []
        },
        description: 'Clones seat/zone catalogs for the event season/venue and optionally attaches a custom plan view.',
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'venue',
              label: 'Slug du lieu (si différent ou manquant)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'venueView',
              label: 'Vue plan (optionnel)',
              placeholder: 'vue-alternative',
              arg: { type: 'option', template: '--venue-view=${value}' },
              options: [
                { label: '— Aucune vue spécifique —', value: '' },
                { label: 'Vue personnalisée (ex: aisc)', value: 'aisc' }
              ]
            }
          ]
        }
      },
      {
        id: 'event-instantiate-tariffs',
        label: 'Instantiate Tariffs for Event',
        order: 1,
        path: 'scripts/04-event-management/instantiate-tariffs.js',
        command: 'node scripts/04-event-management/instantiate-tariffs.js --event=<slug> --catalog=<slug[,slug2]> [--clear] [--dry-run]',
        run: {
          script: 'scripts/04-event-management/instantiate-tariffs.js',
          args: []
        },
        description: 'Clones one or more tariff catalogs into the event price table.',
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'catalog',
              label: 'Catalogues (slug[,slug2])',
              placeholder: 'season-game',
              required: true,
              arg: { type: 'option', template: '--catalog=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-instantiate-ad-campaigns',
        label: 'Instantiate Ad Campaigns for Event',
        order: 1.2,
        path: 'scripts/04-event-management/instantiate-ad-campaigns.js',
        command: 'node scripts/04-event-management/instantiate-ad-campaigns.js --event=<slug> --catalog=<slug[,slug2]> [--clear] [--dry-run] [--set-theme=<value>]',
        run: {
          script: 'scripts/04-event-management/instantiate-ad-campaigns.js',
          args: []
        },
        description: 'Clones one or more ad campaign catalogs into the event, so tickets pick up sponsor content matching their own tariffCode/zoneKey/zoneType. Takes priority over the season default (see Instantiate Ad Campaigns for Season) when both exist.',
        notes: [
          'Set "theme" to also switch this event\'s ticket/email to the matching themed template (see Set Event Theme) — optional, leave blank to only instantiate the placements.'
        ],
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'catalog',
              label: 'Catalogues (slug[,slug2])',
              placeholder: 'sponsors-2026',
              required: true,
              arg: { type: 'option', template: '--catalog=${value}' }
            },
            {
              name: 'theme',
              label: 'Thème à appliquer (optionnel)',
              placeholder: 'ads',
              arg: { type: 'option', template: '--set-theme=${value}' }
            }
          ]
        }
      },
      {
        id: 'set-event-theme',
        label: 'Set Event Theme',
        order: 1.3,
        path: 'scripts/04-event-management/set-event-theme.js',
        command: 'node scripts/04-event-management/set-event-theme.js --event=<slug> [--theme=<value>|--clear] [--dry-run]',
        run: {
          script: 'scripts/04-event-management/set-event-theme.js',
          args: []
        },
        description: 'Sets (or clears) Event.templateTheme — an explicit override checked before the customization-layered "theme" key, driving both the ticket PDF and confirmation email for this event.',
        notes: [
          'A theme only does anything once a matching file exists (tickets/<file>.<theme>.svg and/or email/<file>.<theme>.html) — see Set Ticket Template / Set Email Template with --theme=.'
        ],
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'theme',
              label: 'Thème (vide + effacer = retombe sur la customization)',
              placeholder: 'ads',
              arg: { type: 'option', template: '--theme=${value}' }
            },
            {
              name: 'clear',
              label: 'Effacer le thème',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--clear' }
            }
          ]
        }
      },
      {
        id: 'event-remove-tariffs',
        label: 'Remove Event Tariffs',
        order: 1.5,
        path: 'scripts/04-event-management/remove-event-tariffs.js',
        command: 'node scripts/04-event-management/remove-event-tariffs.js --event=<slug> --force',
        run: {
          script: 'scripts/04-event-management/remove-event-tariffs.js',
          args: ['--force']
        },
        description: 'Deletes the instantiated Tariff/TariffPrice rows for one event\'s priceTableKey — does not delete the event itself. Refuses if another event shares the same priceTableKey (a custom/shared table isn\'t this event\'s alone to remove).',
        danger: true,
        notes: [
          'Existing paid orders keep their own captured prices regardless — this only means the event can\'t be purchased from until tariffs are re-instantiated.',
          'Run the equivalent CLI command with --dry-run first to see the row counts before confirming here.'
        ],
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-remove-ad-campaigns',
        label: 'Remove Event Ad Campaigns',
        order: 1.7,
        path: 'scripts/04-event-management/remove-event-ad-campaigns.js',
        command: 'node scripts/04-event-management/remove-event-ad-campaigns.js --event=<slug> --force',
        run: {
          script: 'scripts/04-event-management/remove-event-ad-campaigns.js',
          args: ['--force']
        },
        description: 'Deletes the instantiated AdCampaignPlacement rows for one event\'s priceTableKey — does not delete the event itself or touch AdCampaign masters. Refuses if another event shares the same priceTableKey.',
        danger: true,
        notes: [
          'Run the equivalent CLI command with --dry-run first to see the row counts before confirming here.'
        ],
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-build-allowed',
        label: 'Build Allowed-From Prices',
        order: 2,
        path: 'scripts/04-event-management/build-allowed-from-prices.js',
        command: 'node scripts/04-event-management/build-allowed-from-prices.js --event=<slug> --season=<code> --venue=<slug>',
        run: {
          script: 'scripts/04-event-management/build-allowed-from-prices.js',
          args: []
        },
        description: 'Recomputes allowed-from pricing for an event based on zone tariffs.',
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'season',
              label: 'Code saison (optionnel)',
              placeholder: '2025-2026',
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'venue',
              label: 'Slug du lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-publish-event',
        label: 'Publish Event (sale / activity)',
        order: 3,
        path: 'scripts/04-event-management/publish-event.js',
        command: 'node scripts/04-event-management/publish-event.js --event=<slug|ObjectId> [--sale=<state>] [--activity=<state>]',
        run: {
          script: 'scripts/04-event-management/publish-event.js',
          args: []
        },
        description: 'Sets the event\'s sale lifecycle (notopen -> presale -> onsale -> [soldout] -> closed) and/or its activity lifecycle (draft -> active -> archived). Provide at least one of the two.',
        notes: [
          'Accepts either the event slug or its MongoDB ObjectId.',
          'sale=onsale is what actually opens checkout to the public — the other sale states (notopen/presale/soldout/closed) all keep public checkout closed; partner presale quotas still apply on top unless sale is soldout or closed.'
        ],
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'sale',
              label: 'État de vente (optionnel)',
              arg: { type: 'option', template: '--sale=${value}' },
              options: [
                { label: '— (ne pas changer)', value: '' },
                { label: 'Pas encore ouvert', value: 'notopen' },
                { label: 'Prévente', value: 'presale' },
                { label: 'En vente', value: 'onsale' },
                { label: 'Complet', value: 'soldout' },
                { label: 'Fermé', value: 'closed' }
              ]
            },
            {
              name: 'activity',
              label: 'État de publication (optionnel)',
              arg: { type: 'option', template: '--activity=${value}' },
              options: [
                { label: '— (ne pas changer)', value: '' },
                { label: 'Brouillon', value: 'draft' },
                { label: 'Actif', value: 'active' },
                { label: 'Archivé', value: 'archived' }
              ]
            }
          ]
        }
      },
      {
        id: 'event-cancel-order',
        label: 'Cancel Event Order',
        order: 3.3,
        path: 'scripts/04-event-management/cancel-order.js',
        command: 'node scripts/04-event-management/cancel-order.js --order=<orderId> [--event=<slug|ObjectId>] [--commit]',
        run: {
          script: 'scripts/04-event-management/cancel-order.js',
          args: []
        },
        description: 'Cancels an event order, releases seats, and marks lines as released. Dry-run by default; add --commit to apply.',
        form: {
          fields: [
            {
              name: 'order',
              label: 'Order ID',
              placeholder: '6652f1…c123',
              required: true,
              arg: { type: 'option', template: '--order=${value}' }
            },
            {
              name: 'event',
              label: 'Event slug/ID (optionnel)',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              arg: { type: 'option', template: '--event=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-sync-season-orders',
        label: 'Sync Season Orders to Event',
        order: 3.4,
        path: 'scripts/04-event-management/sync-season-orders-to-event.js',
        command: 'node scripts/04-event-management/sync-season-orders-to-event.js --event=<slug|ObjectId> [--commit]',
        run: {
          script: 'scripts/04-event-management/sync-season-orders-to-event.js',
          args: []
        },
        description: 'Clones paid subscription orders into child event orders so subscribers receive tickets. Dry-run by défaut (sans --commit).',
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l\'événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-import-orders',
        label: 'Import Orders for Event',
        order: 3.5,
        path: 'scripts/04-event-management/import-orders.js',
        command: 'node scripts/04-event-management/import-orders.js <path/to/orders.csv> [--status=paid|tobepaid] [--commit] [--force] [--sendEmail]',
        run: {
          script: 'scripts/04-event-management/import-orders.js',
          args: []
        },
        description: 'Re-import or create event orders from a CSV export. Dry-run by default; add --commit to persist. With --sendEmail: paid-like statuses send confirmations, tobepaid sends a payment link.',
        templates: ['data_references/csv/event-orders.template.csv'],
        form: {
          fields: [
            {
              name: 'csv',
              label: 'CSV commandes',
              placeholder: 'data/inputs/event-orders.csv',
              required: true,
              arg: { type: 'positional', index: 0 }
            }
          ]
        }
      },
      {
        id: 'event-send-payment-links',
        label: 'Send Payment Links for Event Orders',
        order: 3.55,
        path: 'scripts/04-event-management/send-payment-links.js',
        command: 'node scripts/04-event-management/send-payment-links.js --event=<slug|ObjectId> [--order=<id[,id2]>] [--status=pending,tobepaid|nonpaid|all] [--limit=200] [--commit] [--mail=false]',
        run: {
          script: 'scripts/04-event-management/send-payment-links.js',
          args: []
        },
        description: 'Creates fresh checkout intents and sends payment-link emails for unpaid event orders. Dry-run by default; use --commit to execute.',
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l\'evenement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'order',
              label: 'IDs commande (CSV)',
              placeholder: '67f...,680...',
              arg: { type: 'option', template: '--order=${value}' }
            },
            {
              name: 'status',
              label: 'Filtre statut',
              placeholder: 'pending,tobepaid',
              arg: { type: 'option', template: '--status=${value}' }
            },
            {
              name: 'limit',
              label: 'Limite',
              placeholder: '200',
              arg: { type: 'option', template: '--limit=${value}' }
            },
            {
              name: 'mail',
              label: 'Envoyer email',
              placeholder: 'true',
              arg: { type: 'option', template: '--mail=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-export-attendance-overrides',
        label: 'Export Attendance Overrides',
        order: 3.6,
        path: 'scripts/04-event-management/export-attendance-overrides.js',
        command: 'node scripts/04-event-management/export-attendance-overrides.js --event=<slug|ObjectId> [--statuses=released,moved] [--out=overrides.csv]',
        run: {
          script: 'scripts/04-event-management/export-attendance-overrides.js',
          args: []
        },
        description: 'Exports event lines flagged released/moved for follow-up (CSV by default).',
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l\'événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'statuses',
              label: 'Statuts (CSV)',
              placeholder: 'released,moved',
              arg: { type: 'option', template: '--statuses=${value}' }
            },
            {
              name: 'out',
              label: 'Fichier de sortie',
              placeholder: 'data/outputs/event-overrides.csv',
              arg: { type: 'option', template: '--out=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-export-orders',
        label: 'Export Orders for Event',
        order: 3.6,
        path: 'scripts/04-event-management/export-orders.js',
        command: 'node scripts/04-event-management/export-orders.js --event=<slug|ObjectId> [--status=paid] [--out=orders.csv]',
        run: {
          script: 'scripts/04-event-management/export-orders.js',
          args: []
        },
        description: 'Exports event orders (one row per ticket) matching the same CSV format as the import tool.',
        templates: ['data_references/csv/event-orders.template.csv'],
        notes: [
          'Streams to stdout by default; provide --out to write directly to a file.'
        ],
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'status',
              label: 'Statut (optionnel)',
              placeholder: 'paid',
              arg: { type: 'option', template: '--status=${value}' }
            },
            {
              name: 'out',
              label: 'Fichier (optionnel)',
              placeholder: 'data/outputs/event-orders.csv',
              arg: { type: 'option', template: '--out=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-export-tickets',
        label: 'Export Tickets for Event',
        order: 3.65,
        path: 'scripts/04-event-management/export-tickets.js',
        command: 'node scripts/04-event-management/export-tickets.js --event=<slug|ObjectId> [--out=tickets.csv] [--include-history]',
        run: {
          script: 'scripts/04-event-management/export-tickets.js',
          args: []
        },
        description: 'Exports event tickets with QR metadata and scan status for downstream reconciliation.',
        notes: [
          'Add --include-history to append a pipe-separated scanHistory column (chronological log).'
        ],
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'out',
              label: 'Fichier (optionnel)',
              placeholder: 'data/outputs/event-tickets.csv',
              arg: { type: 'option', template: '--out=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-import-qr-bank',
        label: 'Import QR Bank',
        order: 4,
        path: 'scripts/04-event-management/import-qr-bank.js',
        command: 'node scripts/04-event-management/import-qr-bank.js --event=<slug> --csv=<codes.csv> [--append]',
        run: {
          script: 'scripts/04-event-management/import-qr-bank.js',
          args: []
        },
        description: 'Imports QR codes for an event as a single shared pool.',
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'csv',
              label: 'CSV QR bank',
              placeholder: 'data/inputs/qr-bank.csv',
              required: true,
              arg: { type: 'option', template: '--csv=${value}' }
            }
          ]
        }
      },
      {
        id: 'block-free-seats-for-event',
        label: 'Block/Free Seats for Event',
        order: 5,
        path: 'scripts/04-event-management/block-free-seats-for-event.js',
        command: 'node scripts/04-event-management/block-free-seats-for-event.js --event=<slug> --file=<holds.csv> [--commit] [--force]',
        run: {
          script: 'scripts/04-event-management/block-free-seats-for-event.js',
          args: []
        },
        description: 'Blocks or frees event seat holds based on a CSV describing action, seatId/seatPattern/zoneKey, reason, and expiry.',
        notes: [
          'Without --commit the script runs in dry-run mode; add --force to overwrite existing holds.'
        ],
        templates: ['data_references/csv/seats-hold-release.template.csv'],
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'file',
              label: 'CSV holds',
              placeholder: 'data/inputs/holds.csv',
              required: true,
              arg: { type: 'option', template: '--file=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-send-all-season-tickets',
        label: 'Send All Season Tickets for Event',
        order: 6,
        path: 'scripts/04-event-management/send-all-season-tickets-for-event.js',
        command: 'node scripts/04-event-management/send-all-season-tickets-for-event.js --event=<slug> [--limit=200] [--dry-run] [--force]',
        run: {
          script: 'scripts/04-event-management/send-all-season-tickets-for-event.js',
          args: []
        },
        description: 'Ensures event orders carry tickets and emails them to subscribers (works on orders created by the sync command).',
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'limit',
              label: 'Limite d’envois (optionnel)',
              placeholder: '200',
              arg: { type: 'option', template: '--limit=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-resend-tickets',
        label: 'Resend Tickets for Event',
        order: 7.2,
        path: 'scripts/04-event-management/resend-event-tickets.js',
        command: 'node scripts/04-event-management/resend-event-tickets.js --event=<slug> --order=<orderId[,orderId2]> [--status=paid] [--commit]',
        run: {
          script: 'scripts/04-event-management/resend-event-tickets.js',
          args: []
        },
        description: 'Resends event ticket emails for specific order IDs. Dry-run by default; add --commit to send.',
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'order',
              label: 'OrderId (séparés par des virgules)',
              placeholder: '6652f1…c123,6652f2…c456',
              required: true,
              arg: { type: 'option', template: '--order=${value}' }
            },
            {
              name: 'status',
              label: 'Forcer statut (optionnel)',
              placeholder: 'paid',
              arg: { type: 'option', template: '--status=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-tickets-pdf',
        label: 'Generate Tickets PDF',
        order: 8,
        path: 'scripts/04-event-management/tickets-pdf.js',
        command: 'node scripts/04-event-management/tickets-pdf.js --event=<slug> --id=<orderId>',
        run: {
          script: 'scripts/04-event-management/tickets-pdf.js',
          args: []
        },
        description: 'Builds a PDF of tickets for a given order, reusing QR codes from the bank.',
        form: {
          fields: [
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'orderId',
              label: 'ID de commande',
              placeholder: '6651e5e0ff7ad4...',
              required: true,
              arg: { type: 'option', template: '--id=${value}' }
            },
            {
              name: 'out',
              label: 'Fichier de sortie (optionnel)',
              placeholder: 'data/outputs/tickets-<order>.pdf',
              arg: { type: 'option', template: '--out=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-delete',
        label: 'Delete Event',
        order: 99,
        path: 'scripts/04-event-management/delete-event.js',
        command: 'node scripts/04-event-management/delete-event.js --event=<slug> --force',
        run: {
          script: 'scripts/04-event-management/delete-event.js',
          args: ['--force']
        },
        description: 'Permanently deletes an event: Tickets, SeatHolds, ScanLog, Orders, its Tariff/TariffPrice (only if not shared with another event), the Event itself, and its customization file. Never touches Seat/Zone/SeatCatalog/ZoneCatalog/TariffPriceCatalog — those are shared venue infrastructure, not event-scoped.',
        danger: true,
        notes: [
          'Refuses to run if the event has any paid/tobepaid/refunded orders or scanned tickets — that requires --allow-paid-orders on the command line, deliberately not exposed here, so a real financial/attendance record can never be wiped from the admin UI by accident.',
          'Run the equivalent CLI command with --dry-run first to see exactly what would be deleted, with counts, before confirming here.',
          'Tariff/TariffPrice are only deleted if no other event shares this event\'s priceTableKey (a custom/shared price table is left alone).'
        ],
        form: {
          fields: [
            {
              name: 'event',
              label: 'Événement à supprimer (slug ou ID)',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              required: true,
              arg: { type: 'option', template: '--event=${value}' }
            }
          ]
        }
      }
    ]
  },
  {
    id: '05-partner-management',
    label: '05 — Partner',
    order: 5,
    description: 'Manage partner-specific access, iframe restrictions, and payment modes backed by data/customization/partners.json.',
    scripts: [
      {
        id: 'partners-init-template',
        label: 'Init Partner Template',
        order: 5,
        path: 'scripts/05-partner-management/init-partners.js',
        command: 'node scripts/05-partner-management/init-partners.js [--force]',
        run: {
          script: 'scripts/05-partner-management/init-partners.js',
          args: []
        },
        description: 'Creates data/customization/partners.json with starter entries (cseairbus, aisc).',
        notes: [
          'Use --force to overwrite an existing file; otherwise the script exits without modifying it.',
          'Edit the JSON afterwards for copy, iframe origins, payment behavior.'
        ],
        form: { fields: [] }
      },
      {
        id: 'set-partner-custo',
        label: 'Set Partner Customization',
        order: 1,
        path: 'scripts/05-partner-management/set-partner-custo.js',
        command: 'node scripts/05-partner-management/set-partner-custo.js (--partner=<slug> | --all-partners) --file=<customization.json> [--season=<code>] [--event=<slug>]',
        run: {
          script: 'scripts/05-partner-management/set-partner-custo.js',
          args: []
        },
        description: 'Enregistre l\'habillage (titres, chapôs, libellés) d\'un partenaire, ou de TOUS les partenaires à la fois.',
        notes: [
          'Cochez « Tous les partenaires » pour écrire data/customization/partners/_default.json : le texte partenaire générique est déjà rédigé avec {{partnerName}}, il n\'a donc pas à être recopié pour chaque partenaire.',
          'Sinon, indiquez un slug : le fichier du partenaire surcharge la couche commune.',
          'Exactement une des deux portées à la fois. « Tous les partenaires » ne se combine pas avec saison/événement, qui sont propres à un partenaire.',
          'N\'y copier que les clés réellement différentes : recopier tout le gabarit fige une version de chaque texte, et une correction ultérieure ne l\'atteindrait plus.',
          'Gabarit des clés disponibles : data_references/customization/partner.json (ses annotations « _… » ne sont pas recopiées).'
        ],
        templates: [
          'data_references/customization/partner.json',
          'data/customization/partners/_default.json',
          'data/customization/partners/<slug>.json',
          'data/customization/partners/<slug>/seasons/<code>.json',
          'data/customization/partners/<slug>/events/<event>.json'
        ],
        form: {
          fields: [
            {
              name: 'allPartners',
              label: 'Tous les partenaires (habillage commun)',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--all-partners' }
            },
            {
              name: 'partner',
              label: 'Slug du partenaire (si non « tous »)',
              placeholder: 'cseairbus',
              arg: { type: 'option', template: '--partner=${value}' }
            },
            {
              name: 'season',
              label: 'Code saison (optionnel)',
              placeholder: '2025-2026',
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'event',
              label: 'Slug événement (optionnel)',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'file',
              label: 'JSON customization',
              placeholder: 'data/customization/partners/<slug>.json',
              required: true,
              arg: { type: 'option', template: '--file=${value}' }
            }
          ]
        }
      },
      {
        id: 'partner-upsert',
        label: 'Create / Update Partner',
        order: 0,
        path: 'scripts/05-partner-management/upsert-partner.js',
        command: 'node scripts/05-partner-management/upsert-partner.js --slug=<slug> --name="<Display Name>" [--payment-mode=psp|invoice_auto] [--allow-public-tariffs=yes|no] [--payment-provider=...]',
        run: {
          script: 'scripts/05-partner-management/upsert-partner.js',
          args: []
        },
        description: 'Adds or updates a partner entry in data/customization/partners.json (consumed at runtime via config/partners.js).',
        notes: [
          'For invoice_auto mode you can set payment-provider, pay-button, success-message, error-message, auto-finalize, send-tickets.'
        ],
        form: {
          fields: [
            { name: 'partner', label: 'Slug', placeholder: 'cseairbus', required: true, arg: { type: 'option', template: '--slug=${value}' } },
            { name: 'name', label: 'Nom affiché', placeholder: 'CSE Airbus', required: true, arg: { type: 'option', template: '--name=${value}' } },
            { name: 'paymentMode', label: 'Mode de paiement', placeholder: 'psp | invoice_auto', arg: { type: 'option', template: '--payment-mode=${value}' } },
            { name: 'allowPublicTariffs', label: 'Autoriser les tarifs publics', hint: 'yes|no (par défaut: no). Si yes, les tarifs publics seront accessibles en fallback.', arg: { type: 'option', template: '--allow-public-tariffs=${value}' } },
            { name: 'paymentProvider', label: 'ID prestataire (invoice_auto)', placeholder: 'cseairbus_invoice', arg: { type: 'option', template: '--payment-provider=${value}' } },
            { name: 'payButton', label: 'Libellé bouton (invoice_auto)', placeholder: 'Envoyer ma demande', arg: { type: 'option', template: '--pay-button=${value}' } },
            { name: 'successMessage', label: 'Message succès (invoice_auto)', placeholder: 'Votre demande a été enregistrée...', arg: { type: 'option', template: '--success-message=${value}' } },
            { name: 'errorMessage', label: 'Message erreur (invoice_auto)', placeholder: 'Impossible d’enregistrer votre demande...', arg: { type: 'option', template: '--error-message=${value}' } },
            { name: 'autoFinalize', label: 'Auto-finaliser (invoice_auto)', placeholder: 'yes|no', arg: { type: 'option', template: '--auto-finalize=${value}' } },
            { name: 'sendTickets', label: 'Envoyer billets (invoice_auto)', placeholder: 'yes|no', arg: { type: 'option', template: '--send-tickets=${value}' } }
          ]
        }
      },
      {
        id: 'partner-set-security',
        label: 'Partner Security (origins)',
        order: 3,
        path: 'scripts/05-partner-management/set-partner-security.js',
        command: 'node scripts/05-partner-management/set-partner-security.js --slug=<slug> [--allowed-origins=CSV] [--frame-ancestors=CSV]',
        run: { script: 'scripts/05-partner-management/set-partner-security.js', args: [] },
        description: 'Updates iframe/embed security for a partner (allowed origins, frame-ancestors).',
        form: {
          fields: [
            {
              name: 'partner',
              label: 'Slug',
              placeholder: 'cseairbus',
              required: true,
              arg: { type: 'option', template: '--slug=${value}' }
            },
            {
              name: 'allowedOrigins',
              label: 'Allowed origins (iframe parent)',
              placeholder: 'https://partner.example.com,https://intranet.example.com',
              arg: { type: 'option', template: '--allowed-origins=${value}' }
            },
            {
              name: 'frameAncestors',
              label: 'CSP frame-ancestors',
              placeholder: 'https://partner.example.com',
              arg: { type: 'option', template: '--frame-ancestors=${value}' }
            }
          ]
        }
      },
      {
        id: 'partner-set-view',
        label: 'Partner View',
        order: 1,
        path: 'scripts/05-partner-management/set-partner-view.js',
        command: 'node scripts/05-partner-management/set-partner-view.js --slug=<slug> --venue-view=<slug> [--event=<eventSlug>] [--season=<code>]',
        run: { script: 'scripts/05-partner-management/set-partner-view.js', args: [] },
        description: 'Sets a partner venue view override (optionally scoped to an event or season).',
        form: {
          fields: [
            { name: 'partner', label: 'Slug', placeholder: 'cseairbus', required: true, arg: { type: 'option', template: '--slug=${value}' } },
            { name: 'venueView', label: 'Vue plan', placeholder: 'cseairbus-view', required: true, arg: { type: 'option', template: '--venue-view=${value}' } },
            { name: 'season', label: 'Code saison (optionnel)', placeholder: '2025-2026', arg: { type: 'option', template: '--season=${value}' } },
            { name: 'event', label: 'Slug événement (optionnel)', placeholder: 'match-2025-09-21-bts-vs-xxx', arg: { type: 'option', template: '--event=${value}' } }
          ]
        }
      },
      {
        id: 'partner-set-presale',
        label: 'Set Partner Pre-sale Quota',
        order: 5,
        path: 'scripts/05-partner-management/set-partner-presale.js',
        command: 'node scripts/05-partner-management/set-partner-presale.js --partner=<slug> (--event=<eventSlug> | --season=<seasonCode>) --quota=<number>',
        run: { script: 'scripts/05-partner-management/set-partner-presale.js', args: [] },
        description: 'Ouvre à un partenaire une fenêtre de vente anticipée, sur UN événement ou sur UNE saison.',
        notes: [
          '--event : le quota se compte en PLACES sur ce match.',
          '--season : le quota se compte en ABONNEMENTS sur cette saison — un abonné vaut 1, siège nominatif ou place en zone.',
          'Renseignez exactement une cible : un quota places et un quota abonnements ne se déduisent pas l\'un de l\'autre.',
          'Quota = 0 retire la prévente. --show affiche les quotas déjà posés sans rien changer.',
          'Pour une saison, le quota reste un plafond même après l\'ouverture publique (allocation contractuelle) ; côté événement il ne borne que la prévente.'
        ],
        form: {
          fields: [
            { name: 'partner', label: 'Partner', placeholder: 'partner01', required: true, arg: { type: 'option', template: '--partner=${value}' } },
            { name: 'event', label: 'Événement (quota en places)', placeholder: 'match-2026-02-14', arg: { type: 'option', template: '--event=${value}' } },
            { name: 'season', label: 'Saison (quota en abonnements)', placeholder: '2026-2027', arg: { type: 'option', template: '--season=${value}' } },
            { name: 'quota', label: 'Quota', placeholder: '100', arg: { type: 'option', template: '--quota=${value}' } },
            { name: 'show', label: 'Afficher les quotas existants', type: 'checkbox', arg: { type: 'flag', flag: '--show' } }
          ]
        }
      },
      {
        id: 'partner-import-csv',
        label: 'Import Partners (CSV)',
        order: 2,
        path: 'scripts/05-partner-management/import-partners.js',
        command: 'node scripts/05-partner-management/import-partners.js <partners.csv> [--replace]',
        run: {
          script: 'scripts/05-partner-management/import-partners.js',
          args: []
        },
        description: 'Import partners from CSV into data/customization/partners.json; merges by default, or replaces when --replace is provided.',
        templates: ['data_references/csv/partners.template.csv'],
        notes: [
          'Columns: slug,name,paymentMode,allowedOrigins,frameAncestors,paymentProvider,payButtonLabel,successMessage,errorMessage,autoFinalize,sendTickets,uiHeading,uiLead,uiPaymentHelp.'
        ],
        form: {
          fields: [
            {
              name: 'csv',
              label: 'CSV partenaires',
              placeholder: 'data/inputs/partners.csv',
              required: true,
              arg: { type: 'positional', index: 0 }
            }
          ]
        }
      },
      {
        id: 'partner-export-csv',
        label: 'Export Partners (CSV)',
        order: 3,
        path: 'scripts/05-partner-management/export-partners.js',
        command: 'node scripts/05-partner-management/export-partners.js [--out=partners.csv]',
        run: {
          script: 'scripts/05-partner-management/export-partners.js',
          args: []
        },
        description: 'Export partners.json to CSV (stdout or --out=<file>).',
        templates: ['data_references/csv/partners.template.csv'],
        form: {
          fields: [
            {
              name: 'out',
              label: 'Fichier de sortie (optionnel)',
              placeholder: 'data/outputs/partners.csv',
              arg: { type: 'option', template: '--out=${value}' }
            }
          ]
        }
      },
      {
        id: 'partner-generate-token',
        label: 'Generate Partner Token',
        order: 4,
        path: 'scripts/05-partner-management/generate-partner-token.js',
        command: 'node scripts/05-partner-management/generate-partner-token.js --partner=<slug> [--event=<eventSlug> | --season=<code> | --default] [--force]',
        run: {
          script: 'scripts/05-partner-management/generate-partner-token.js',
          args: []
        },
        description: 'Generate or reuse a partner token (default or per-event) in partners.json and print the URL with ?token=...',
        notes: [
          'Defaults to --default when no target is provided.',
          'Use --force to regenerate even if a token already exists.',
          'For event tokens, the URL is printed with the token query param.'
        ],
        form: {
          fields: [
            {
              name: 'partner',
              label: 'Partner slug',
              placeholder: 'partner01',
              required: true,
              arg: { type: 'option', template: '--partner=${value}' }
            },
            {
              name: 'event',
              label: 'Event slug (optionnel)',
              placeholder: 'event01',
              arg: { type: 'option', template: '--event=${value}' }
            },
            {
              name: 'season',
              label: 'Season code (optionnel)',
              placeholder: '2025-2026',
              arg: { type: 'option', template: '--season=${value}' }
            }
          ]
        }
      },
      {
        id: 'partner-set-admin',
        label: 'Set Partner Admin Credentials',
        order: 5,
        path: 'scripts/05-partner-management/set-partner-admin.js',
        command: 'node scripts/05-partner-management/set-partner-admin.js --partner=<slug> --user=<login> --pass=<password>',
        run: {
          script: 'scripts/05-partner-management/set-partner-admin.js',
          args: []
        },
        description: 'Set or update Basic Auth credentials for the partner admin page (/partner/<slug>/admin).',
        form: {
          fields: [
            {
              name: 'partner',
              label: 'Partner slug',
              placeholder: 'partner01',
              required: true,
              arg: { type: 'option', template: '--partner=${value}' }
            },
            {
              name: 'user',
              label: 'Login',
              placeholder: 'admin',
              required: true,
              arg: { type: 'option', template: '--user=${value}' }
            },
            {
              name: 'pass',
              label: 'Mot de passe',
              placeholder: '********',
              required: true,
              arg: { type: 'option', template: '--pass=${value}' }
            }
          ]
        }
      }
    ]
  },
  {
    id: '06-misc',
    label: '06 — Misc',
    order: 6,
    description: 'Miscellaneous operational scripts: exports, audits, order management, and sentinels.',
    scripts: [
      {
        id: 'export-orders',
        label: 'Export Orders (CSV)',
        order: 0,
        path: 'scripts/06-misc/reports/export-orders.js',
        command: 'node scripts/06-misc/reports/export-orders.js [--season=<code>] [--venue=<slug>] [--status=paid]',
        run: {
          script: 'scripts/06-misc/reports/export-orders.js',
          args: []
        },
        description: 'Streams orders to CSV using the shared exports service.',
        notes: [
          'Writes to stdout; redirect to a file if you need a persistent export.'
        ],
        templates: ['data_references/csv/orders-export.template.csv'],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Filtrer par saison (optionnel)',
              placeholder: '2025-2026',
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'venue',
              label: 'Filtrer par lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'status',
              label: 'Statut (optionnel)',
              placeholder: 'paid',
              arg: { type: 'option', template: '--status=${value}' }
            }
          ]
        }
      },
      {
        id: 'orders-import-csv',
        label: 'Import Orders from CSV',
        order: 1,
        path: 'scripts/orders-import-csv.js',
        command: 'node scripts/orders-import-csv.js --file=<orders.csv> [--send] [--commit]',
        run: {
          script: 'scripts/orders-import-csv.js',
          args: []
        },
        description: 'Creates paid orders (with tickets) from a CSV and optionally emails confirmations.',
        notes: [
          'Columns: eventId, quantity, payerFirstName, payerLastName, payerEmail, seatId, zoneKey, tariffCode.',
          'Runs in dry-run mode unless --commit; add --send to trigger confirmations.'
        ],
        form: {
          fields: [
            {
              name: 'file',
              label: 'CSV commandes',
              placeholder: 'data/inputs/orders.csv',
              required: true,
              arg: { type: 'option', template: '--file=${value}' }
            }
          ]
        }
      },
      {
        id: 'orders-delete-csv',
        label: 'Delete Orders from CSV',
        order: 2,
        path: 'scripts/orders-delete-csv.js',
        command: 'node scripts/orders-delete-csv.js --file=<orders.csv> [--commit] [--force]',
        run: {
          script: 'scripts/orders-delete-csv.js',
          args: []
        },
        description: 'Cancels (soft) or deletes (hard) orders listed in a CSV, voiding their tickets.',
        notes: [
          'Columns: orderId, mode=soft|hard. Soft marks as cancelled; hard removes the order and voids tickets.',
          'Dry-run unless --commit. Use --force to insist on hard deletes.'
        ],
        form: {
          fields: [
            {
              name: 'file',
              label: 'CSV commandes',
              placeholder: 'data/inputs/orders-delete.csv',
              required: true,
              arg: { type: 'option', template: '--file=${value}' }
            }
          ]
        }
      },
      {
        id: 'export-seats',
        label: 'Export Seats (CSV)',
        order: 3,
        path: 'scripts/06-misc/reports/export-seats.js',
        command: 'node scripts/06-misc/reports/export-seats.js [--season=<code>] [--venue=<slug>] [--zone=<key>]',
        run: {
          script: 'scripts/06-misc/reports/export-seats.js',
          args: []
        },
        description: 'Streams seats with provisioning and booking metadata to CSV.',
        notes: [
          'Combines seat availability with latest paid order info for each seat.'
        ],
        templates: ['data_references/csv/seats-export.template.csv'],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Filtrer par saison (optionnel)',
              placeholder: '2025-2026',
              arg: { type: 'option', template: '--season=${value}' }
            },
            {
              name: 'venue',
              label: 'Filtrer par lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'zone',
              label: 'Filtrer par zone (optionnel)',
              placeholder: 'TBH7',
              arg: { type: 'option', template: '--zone=${value}' }
            }
          ]
        }
      },
      {
        id: 'pending-orders-sentinel',
        label: 'Sentinel: Pending Orders',
        order: 4,
        path: 'scripts/sentinels/pending-orders.js',
        command: 'node scripts/sentinels/pending-orders.js [--max-age-minutes=60]',
        run: {
          script: 'scripts/sentinels/pending-orders.js',
          args: []
        },
        description: 'Reports orders stuck in pending state beyond the expected delay.',
        notes: [
          'Use --sinceMinutes to widen the scan window; defaults to 180 minutes.'
        ],
        form: {
          fields: [
            {
              name: 'maxAge',
              label: 'Ancienneté max (minutes)',
              placeholder: '60',
              arg: { type: 'option', template: '--max-age-minutes=${value}' }
            },
            {
              name: 'since',
              label: 'Fenêtre de recherche (minutes)',
              placeholder: '180',
              arg: { type: 'option', template: '--sinceMinutes=${value}' }
            }
          ]
        }
      },
      {
        id: 'resend-order-email',
        label: 'Resend Order Email',
        order: 6,
        path: 'scripts/06-misc/resend-order-email.js',
        command: 'node scripts/06-misc/resend-order-email.js --order=<id> [--commit] [--force]',
        run: { script: 'scripts/06-misc/resend-order-email.js', args: [] },
        description: 'Diagnostique puis renvoie le courriel de confirmation d\'une commande, quel que soit son flux (abonnement, renouvellement, match, partenaire).',
        notes: [
          'Sans « Envoyer », rien n\'est expédié : le script affiche le destinataire, la date du dernier envoi, le mode courriel (SMTP ou EMAIL_STUB) et tente le rendu du message.',
          'Un échec de rendu est la cause la plus fréquente d\'un courriel manquant : il est signalé ici avec son message exact, sans avoir à fouiller les journaux.',
          'Une commande déjà marquée comme envoyée n\'est pas réexpédiée : cocher « Forcer » pour cela.',
          'Complète 04-event-management/resend-event-tickets.js, qui exige un match et ne couvre donc ni les abonnements ni les renouvellements.'
        ],
        form: {
          fields: [
            {
              name: 'order',
              label: 'Identifiant de commande',
              placeholder: '6a95b8572f671ff8b35b4de8',
              required: true,
              arg: { type: 'option', template: '--order=${value}' }
            },
            {
              name: 'commit',
              label: 'Envoyer (sinon diagnostic seul)',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--commit' }
            },
            {
              name: 'force',
              label: 'Forcer même si déjà envoyé',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--force' }
            }
          ]
        }
      },
      {
        id: 'audit-missing-seats',
        label: 'Audit Missing Seats',
        order: 5,
        path: 'scripts/06-misc/audit-missing-seats.js',
        command: 'node scripts/06-misc/audit-missing-seats.js <seasonCode> --venue=<slug>',
        run: {
          script: 'scripts/06-misc/audit-missing-seats.js',
          args: []
        },
        description: 'Checks for discrepancies between seat provisioning and subscriptions.',
        notes: [
          'Produces detailed and grouped CSV outputs; configure --out and --grouped paths as needed.',
          'Les fichiers sont écrits par défaut dans data/outputs.'
        ],
        form: {
          fields: [
            {
              name: 'season',
              label: 'Code saison',
              placeholder: '2025-2026',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'option', template: '--venue=${value}' }
            },
            {
              name: 'out',
              label: 'Fichier détaillé (optionnel)',
              placeholder: 'audit-missing-seats.csv',
              arg: { type: 'option', template: '--out=${value}' }
            },
            {
              name: 'grouped',
              label: 'Fichier groupé (optionnel)',
              placeholder: 'audit-missing-seats-grouped.csv',
              arg: { type: 'option', template: '--grouped=${value}' }
            }
          ]
        }
      }
    ]
  }
];

export function getScriptGroup(id) {
  return adminScriptGroups.find(g => g.id === id) || null;
}

export function getAdminScript(scriptId) {
  for (const group of adminScriptGroups) {
    const script = group.scripts.find(s => s.id === scriptId);
    if (script) return { group, script };
  }
  return null;
}

export function getAdminScriptByTaskId(taskId) {
  if (!taskId) return null;
  for (const group of adminScriptGroups) {
    const script = group.scripts.find(s => s?.automation?.taskId === taskId);
    if (script) return { group, script };
  }
  return null;
}
