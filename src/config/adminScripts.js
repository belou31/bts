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
    label: '00 — System Management',
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
        templates: ['data/templates/env/.env.template'],
        notes: [
          'Make sure the MongoDB URI points to the intended environment before running.',
          'Include --force to acknowledge the drop command.'
        ]
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
        id: 'customize-app',
        label: 'Customize Application',
        order: 2,
        path: 'scripts/00-system-management/customize-app.js',
        command: 'node scripts/00-system-management/customize-app.js --name="<Organization>" [--short-name="<Short>"] [--logo-svg=logo.svg] [--logo-png=logo.png] [--favicon=favicon.ico] [--email-template=template.json]',
        run: {
          script: 'scripts/00-system-management/customize-app.js',
          args: []
        },
        description: 'Copies organization assets (favicon, logos, app icons) to public/static/img and stores optional metadata/templates under data/customization.',
        templates: ['data/templates/customization/app.json'],
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
              placeholder: 'data/inputs/favicon.ico',
              arg: { type: 'option', template: '--favicon=${value}' }
            },
            {
              name: 'logoSvg',
              label: 'Logo vectoriel (.svg)',
              placeholder: 'data/inputs/logo.svg',
              arg: { type: 'option', template: '--logo-svg=${value}' }
            },
            {
              name: 'logoPng',
              label: 'Logo bitmap (.png)',
              placeholder: 'data/inputs/logo.png',
              arg: { type: 'option', template: '--logo-png=${value}' }
            },
            {
              name: 'icon192',
              label: 'Icône 192×192 (.png)',
              placeholder: 'data/inputs/icon-192.png',
              arg: { type: 'option', template: '--icon-192=${value}' }
            },
            {
              name: 'icon512',
              label: 'Icône 512×512 (.png)',
              placeholder: 'data/inputs/icon-512.png',
              arg: { type: 'option', template: '--icon-512=${value}' }
            },
            {
              name: 'emailTemplate',
              label: 'Email template (JSON)',
              placeholder: 'data/inputs/order-confirmation.json',
              hint: 'Vous pouvez répéter l’option en la saisissant via le champ Arguments additionnels.',
              arg: { type: 'option', template: '--email-template=${value}' }
            },
            {
              name: 'emailTemplatesDir',
              label: 'Répertoire de templates e-mail',
              placeholder: 'data/inputs/email-templates',
              arg: { type: 'option', template: '--email-templates=${value}' }
            }
          ]
        }
      }
      ,
      {
        id: 'purge-logs',
        label: 'Purge Logs (Mongo)',
        order: 3,
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
    id: '03-season-management-renewal',
    label: '03 — Season Management · Renewal',
    order: 3.5,
    description: 'Renewal-focused tooling: import legacy subscribers, provision their seats, publish renewal links, and close the campaign.',
    scripts: [
      {
        id: 'import-renewers-flat',
        label: 'Import Renewal Subscribers (flat CSV)',
        order: 0,
        path: 'scripts/03-season-management/import-renewers-flat.js',
        command: 'node scripts/03-season-management/import-renewers-flat.js <path/to/subscribers.csv> <seasonCode> --venue=<slug>',
        run: {
          script: 'scripts/03-season-management/import-renewers-flat.js',
          args: []
        },
        description: 'Loads renewal subscribers from a simple CSV (one seat per row) and marks them as invited.',
        templates: ['data/templates/csv/renew-subscribers.template.csv'],
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
        templates: ['data/templates/csv/renew-groups.template.csv'],
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
        templates: ['data/templates/csv/renew-groups.template.csv'],
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
        templates: ['data/templates/csv/renew-seats.template.csv'],
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
      {
        id: 'renewal-close-phase',
        label: 'Close Renewal Phase',
        order: 4,
        path: 'scripts/03-season-management/renewal-close-phase.js',
        command: 'node scripts/03-season-management/renewal-close-phase.js <seasonCode> [--venue=<slug>]',
        run: {
          script: 'scripts/03-season-management/renewal-close-phase.js',
          args: []
        },
        description: 'Closes the renewal campaign for a season and releases remaining provisioned seats.',
        notes: [
          'Sets Season.enableRenewal to false and clears Seat.status=provisioned.',
          'Provide --venue to limit the release to a single venue.'
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
      }
    ]
  },
  {
    id: '01-venue-management',
    label: '01 — Venue Management',
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
        templates: ['data/templates/files/plan.svg'],
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
              hint: 'Copié dans src/public/static/venues/<slug>/plan.svg si fourni.',
              arg: { type: 'positional', index: 2, optional: true }
            }
          ]
        }
      },
      {
        id: 'import-seats',
        label: 'Import Seats from SVG',
        order: 1,
        path: 'scripts/01-venue-management/import-seats.js',
        command: 'node scripts/01-venue-management/import-seats.js --venue=<slug> [--csv=<path/to/seats.csv>] [--attr=<seatAttribute>] [--plan=<override.svg>]',
        run: {
          script: 'scripts/01-venue-management/import-seats.js',
          args: []
        },
        description: 'Parses the persisted venue plan SVG (copied via register-venue) and stores seats in the catalog. Optionally merge overrides from a CSV mapping (seatId, zoneKey, row, number).',
        templates: [
          'data/templates/files/plan.svg',
          'data/templates/csv/seats.template.csv'
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
              name: 'attr',
              label: 'Attribut des sièges (optionnel)',
              placeholder: 'data-seat-id',
              hint: 'Par défaut data-seat-id dans le SVG ; utilisez-le si vos plans encodent les sièges sous un autre attribut.',
              arg: { type: 'option', template: '--attr=${value}' }
            },
            {
              name: 'plan',
              label: 'Plan SVG override (optionnel)',
              placeholder: 'data/inputs/plan.svg',
              arg: { type: 'option', template: '--plan=${value}' }
            }
          ]
        }
      },
      {
        id: 'import-zones',
        label: 'Import Zones',
        order: 2,
        path: 'scripts/01-venue-management/import-zones.js',
        command: 'node scripts/01-venue-management/import-zones.js --venue=<slug> [--csv=<path/to/zones.csv>] [--attr=<zoneAttribute>] [--plan=<path/to/plan.svg>]',
        run: {
          script: 'scripts/01-venue-management/import-zones.js',
          args: []
        },
        description: 'Maintains the ZoneCatalog for a venue from CSV and/or the persisted SVG plan (data-zone-id by default). Instantiate zones per season afterwards.',
        templates: ['data/templates/csv/zones.template.csv'],
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
              name: 'attr',
              label: 'Attribut des zones (optionnel)',
              placeholder: 'data-zone-id',
              hint: 'Par défaut data-zone-id ; utile si le plan utilise un autre attribut.',
              arg: { type: 'option', template: '--attr=${value}' }
            },
            {
              name: 'plan',
              label: 'Plan SVG override (optionnel)',
              placeholder: 'data/inputs/plan.svg',
              arg: { type: 'option', template: '--plan=${value}' }
            }
          ]
        }
      },
      {
        id: 'import-venue-view',
        label: 'Import Venue View (SVG)',
        order: 4,
        path: 'scripts/01-venue-management/import-venue-view.js',
        command: 'node scripts/01-venue-management/import-venue-view.js <venueSlug> <viewSlug> <path/to/view.svg> [--overwrite]',
        run: {
          script: 'scripts/01-venue-management/import-venue-view.js',
          args: []
        },
        description: 'Copies a custom SVG view for a venue to src/public/static/venues/<slug>/views/<viewSlug>.svg (no seat indexing).',
        templates: ['data/templates/files/plan.svg'],
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
            }
          ]
        }
      },
      {
        id: 'validate-venue-svg',
        label: 'Validate Venue SVG',
        order: 3,
        path: 'scripts/01-venue-management/validate-svg.js',
        command: 'node scripts/01-venue-management/validate-svg.js --svg=<path/to/plan.svg> --selectors="ZONE:#selector" [--min-seats=500] [--fail-on-missing]',
        run: {
          script: 'scripts/01-venue-management/validate-svg.js',
          args: []
        },
        description: 'Checks that the SVG seating plan contains the expected selectors and seat count.',
        form: {
          fields: [
            {
              name: 'svg',
              label: 'Plan SVG',
              placeholder: 'src/public/static/venues/patinoire-blagnac/plan.svg',
              required: true,
              arg: { type: 'option', template: '--svg=${value}' }
            },
            {
              name: 'selectors',
              label: 'Sélecteurs zones',
              placeholder: 'TBH7:#zone-tbh7,DEBOUT:#zone-debout',
              hint: 'Format: ZONE:#css,ZONE2:#css2',
              arg: { type: 'option', template: '--selectors=${value}' }
            },
            {
              name: 'minSeats',
              label: 'Nombre de sièges minimum',
              placeholder: '500',
              arg: { type: 'option', template: '--min-seats=${value}' }
            }
          ]
        }
      }
    ]
  },
  {
    id: '02-tariff-management',
    label: '02 — Tariff Management',
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
        templates: ['data/templates/csv/tariff-catalog.template.csv'],
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
          'Supports list and matrix CSV formats; override detection with --format=list|matrix.',
          'Use --venue=<slug> to scope prices to a specific arena; omit to keep them global.'
        ],
        templates: ['data/templates/csv/tariff-prices.template.csv'],
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
      }
    ]
  },
  {
    id: '03-season-management',
    label: '03 — Season Management',
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
        id: 'set-season-phases',
        label: 'Configure Season Phases',
        order: 0.2,
        path: 'scripts/03-season-management/set-season-phases.js',
        command: 'node scripts/03-season-management/set-season-phases.js <seasonCode> --phase=<renewal|tbh7|public> [--open=ISO] [--close=ISO] [--enabled=true|false]',
        run: {
          script: 'scripts/03-season-management/set-season-phases.js',
          args: []
        },
        description: 'Manages phase scheduling/enabling for a season (renewal, tbh7, public).',
        notes: [
          'Open/close dates expect ISO format (e.g., 2025-08-01T00:00:00Z).',
          'Use enabled=true|false to toggle each phase.'
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
              name: 'phase',
              label: 'Phase',
              required: true,
              arg: { type: 'option', template: '--phase=${value}' },
              options: [
                { label: 'Renouvellement', value: 'renewal' },
                { label: 'TBH7', value: 'tbh7' },
                { label: 'Public', value: 'public' }
              ]
            },
            {
              name: 'open',
              label: 'Ouverture (ISO)',
              placeholder: '2025-08-01T00:00:00Z',
              arg: { type: 'option', template: '--open=${value}' }
            },
            {
              name: 'close',
              label: 'Fermeture (ISO)',
              placeholder: '2025-09-15T22:00:00Z',
              arg: { type: 'option', template: '--close=${value}' }
            },
            {
              name: 'enabled',
              label: 'Activer ? (true/false)',
              placeholder: 'true',
              arg: { type: 'option', template: '--enabled=${value}' }
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
        templates: ['data/templates/csv/orders-export.template.csv'],
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
        templates: ['data/templates/csv/subscribers-export.template.csv'],
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
        templates: ['data/templates/csv/orders-export.template.csv'],
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
        templates: ['data/templates/csv/seats-hold-release.template.csv'],
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
    ]
  },
  {
    id: '04-event-management',
    label: '04 — Event Management',
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
              label: 'Date ISO',
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
        id: 'event-set-onsale',
        label: 'Set Event On-sale',
        order: 3,
        path: 'scripts/04-event-management/set-onsale.js',
        command: 'node scripts/04-event-management/set-onsale.js --event=<slug|ObjectId> [--open|--close]',
        run: {
          script: 'scripts/04-event-management/set-onsale.js',
          args: []
        },
        description: 'Opens or closes ticket sales for an event (use --open / --close / --on=true|false).',
        notes: [
          'Accepts either the event slug or its MongoDB ObjectId.'
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
        command: 'node scripts/04-event-management/import-orders.js <path/to/orders.csv> [--status=paid] [--commit] [--force] [--sendEmail]',
        run: {
          script: 'scripts/04-event-management/import-orders.js',
          args: []
        },
        description: 'Re-import or create paid event orders from a CSV export. Dry-run by default; add --commit to persist and --sendEmail to trigger confirmations.',
        templates: ['data/templates/csv/event-orders.template.csv'],
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
        templates: ['data/templates/csv/event-orders.template.csv'],
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
        templates: ['data/templates/csv/seats-hold-release.template.csv'],
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
      }
    ]
  },
  {
    id: '05-partner-management',
    label: '05 — Partner Management',
    order: 5,
    description: 'Manage partner-specific access, iframe restrictions, and payment modes backed by data/customization/partners.json.',
    scripts: [
      {
        id: 'partners-init-template',
        label: 'Init Partner Template',
        order: 0,
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
        id: 'partner-upsert',
        label: 'Create / Update Partner',
        order: 1,
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
            {
              name: 'slug',
              label: 'Slug',
              placeholder: 'cseairbus',
              required: true,
              arg: { type: 'option', template: '--slug=${value}' }
            },
            {
              name: 'name',
              label: 'Nom affiché',
              placeholder: 'CSE Airbus',
              required: true,
              arg: { type: 'option', template: '--name=${value}' }
            },
            {
              name: 'paymentMode',
              label: 'Mode de paiement',
              placeholder: 'psp | invoice_auto',
              arg: { type: 'option', template: '--payment-mode=${value}' }
            },
            {
              name: 'allowPublicTariffs',
              label: 'Autoriser les tarifs publics',
              hint: 'yes|no (par défaut: no). Si yes, les tarifs publics seront accessibles en fallback.',
              arg: { type: 'option', template: '--allow-public-tariffs=${value}' }
            },
            {
              name: 'paymentProvider',
              label: 'ID prestataire (invoice_auto)',
              placeholder: 'cseairbus_invoice',
              arg: { type: 'option', template: '--payment-provider=${value}' }
            },
            {
              name: 'payButton',
              label: 'Libellé bouton (invoice_auto)',
              placeholder: 'Envoyer ma demande',
              arg: { type: 'option', template: '--pay-button=${value}' }
            },
            {
              name: 'successMessage',
              label: 'Message succès (invoice_auto)',
              placeholder: 'Votre demande a été enregistrée...',
              arg: { type: 'option', template: '--success-message=${value}' }
            },
            {
              name: 'errorMessage',
              label: 'Message erreur (invoice_auto)',
              placeholder: 'Impossible d’enregistrer votre demande...',
              arg: { type: 'option', template: '--error-message=${value}' }
            },
            {
              name: 'autoFinalize',
              label: 'Auto-finaliser (invoice_auto)',
              placeholder: 'yes|no',
              arg: { type: 'option', template: '--auto-finalize=${value}' }
            },
            {
              name: 'sendTickets',
              label: 'Envoyer billets (invoice_auto)',
              placeholder: 'yes|no',
              arg: { type: 'option', template: '--send-tickets=${value}' }
            }
          ]
        }
      },
      {
        id: 'partner-set-security',
        label: 'Partner Security (origins)',
        order: 1.2,
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
        label: 'Partner View & UI',
        order: 1.4,
        path: 'scripts/05-partner-management/set-partner-view.js',
        command: 'node scripts/05-partner-management/set-partner-view.js --slug=<slug> [--venue-view=<slug>] [--ui-heading=\"...\"] [--ui-lead=\"...\"] [--ui-payment-help=\"...\"]',
        run: { script: 'scripts/05-partner-management/set-partner-view.js', args: [] },
        description: 'Customizes the partner plan view and UI copy.',
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
              name: 'venueView',
              label: 'Vue plan (optionnel)',
              placeholder: 'cseairbus-view',
              arg: { type: 'option', template: '--venue-view=${value}' },
              options: [
                { label: '— Aucune vue spécifique —', value: '' },
                { label: 'Exemple : aisc', value: 'aisc' }
              ]
            },
            {
              name: 'uiHeading',
              label: 'Titre page (UI)',
              placeholder: 'Billetterie partenaire',
              arg: { type: 'option', template: '--ui-heading=${value}' }
            },
            {
              name: 'uiLead',
              label: 'Accroche (UI)',
              placeholder: 'Offre négociée ...',
              arg: { type: 'option', template: '--ui-lead=${value}' }
            },
            {
              name: 'uiPaymentHelp',
              label: 'Texte aide paiement (UI)',
              placeholder: 'Paiement sécurisé via BTS.',
              arg: { type: 'option', template: '--ui-payment-help=${value}' }
            }
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
        templates: ['data/templates/csv/partners.template.csv'],
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
        templates: ['data/templates/csv/partners.template.csv'],
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
        templates: ['data/templates/csv/orders-export.template.csv'],
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
        templates: ['data/templates/csv/seats-export.template.csv'],
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
