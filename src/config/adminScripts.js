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
    id: '00-baseline',
    label: '00 — Initialization',
    order: 0,
    description: 'Initialization tasks that prepare the environment, validate configuration, and stage tenant-specific assets.',
    scripts: [
      {
        id: 'reset-db',
        label: 'Reset MongoDB Database',
        order: 0,
        path: 'scripts/00-initialization/reset-db.js',
        command: 'node scripts/00-initialization/reset-db.js --force',
        run: {
          script: 'scripts/00-initialization/reset-db.js',
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
        path: 'scripts/00-initialization/check-env.js',
        command: 'node scripts/00-initialization/check-env.js',
        run: {
          script: 'scripts/00-initialization/check-env.js',
          args: []
        },
        description: 'Verifies the consistency of APP_URL/BASE_PATH and payment provider configuration for the current APP_ENV.'
      },
      {
        id: 'customize-app',
        label: 'Customize Application',
        order: 2,
        path: 'scripts/00-initialization/customize-app.js',
        command: 'node scripts/00-initialization/customize-app.js --name="<Organization>" [--short-name="<Short>"] [--logo-svg=logo.svg] [--logo-png=logo.png] [--favicon=favicon.ico] [--email-template=template.json]',
        run: {
          script: 'scripts/00-initialization/customize-app.js',
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
        command: 'node scripts/03-season-management/send-renew-invites.js <renew-groups.csv> [--dry]',
        automation: {
          taskId: 'season.send-renew-invites',
          defaultDryRun: true
        },
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
              required: true
            },
            {
              name: 'subject',
              label: 'Objet (optionnel)',
              placeholder: 'Renouvellement d’abonnement'
            },
            {
              name: 'seasonCode',
              label: 'Code saison (optionnel)',
              placeholder: '2025-2026'
            },
            {
              name: 'deadline',
              label: 'Date limite (optionnel)',
              placeholder: '31/08/2025'
            },
            {
              name: 'dryRun',
              label: 'Dry-run (ne pas envoyer)',
              type: 'checkbox',
              default: true
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
        command: 'node scripts/01-venue-management/import-seats.js --venue=<slug> [--csv=<path/to/seats.csv>] [--plan=<override.svg>]',
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
        command: 'node scripts/01-venue-management/import-zones.js --venue=<slug> [--csv=<path/to/zones.csv>] [--plan=<path/to/plan.svg>]',
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
              name: 'plan',
              label: 'Plan SVG override (optionnel)',
              placeholder: 'data/inputs/plan.svg',
              arg: { type: 'option', template: '--plan=${value}' }
            },
            {
              name: 'attr',
              label: 'Attribut zone (optionnel)',
              placeholder: 'data-zone-id',
              arg: { type: 'option', template: '--attr=${value}' }
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
        command: 'node scripts/02-tariff-management/import-tariff-prices.js <catalogSlug> <path/to/prices.csv> [--venue=<slug>]',
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
              placeholder: 'list | matrix',
              arg: { type: 'option', template: '--format=${value}' }
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
        id: 'upsert-season',
        label: 'Upsert Season & Phases',
        order: 0,
        path: 'scripts/03-season-management/upsert-season.js',
        command: 'node scripts/03-season-management/upsert-season.js <seasonCode> --name="<Display Name>" [--venue=<slug>] [--enable-renewal]',
        run: {
          script: 'scripts/03-season-management/upsert-season.js',
          args: []
        },
        description: 'Creates or updates a season document and optionally toggles renewal/public phases.',
        notes: [
          'Use --enable-<phase>/--disable-<phase> and --<phase>-open=ISO / --<phase>-close=ISO to manage scheduling.'
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
              name: 'name',
              label: 'Nom affiché (optionnel)',
              placeholder: 'Saison 2025-2026',
              arg: { type: 'option', template: '--name=${value}' }
            },
            {
              name: 'venue',
              label: 'Slug du lieu (optionnel)',
              placeholder: 'patinoire-blagnac',
              arg: { type: 'option', template: '--venue=${value}' }
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
            {
              name: 'activeOnly',
              label: 'Active only',
              arg: { type: 'flag', flag: '--activeOnly' }
            }
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
        id: 'season-provision',
        label: 'Provision Seats (season rules)',
        order: 7,
        path: 'scripts/03-season-management/provision-season-seats.js',
        command: 'node scripts/03-season-management/provision-season-seats.js [--apply]',
        run: {
          script: 'scripts/03-season-management/provision-season-seats.js',
          args: []
        },
        description: 'Applies business rules (VIP, visitors, unavailable…) to mark seats as busy.',
        notes: [
          'Dry-run by default; add --apply to persist updates in MongoDB.'
        ]
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
        command: 'node scripts/04-event-management/create.js --slug=<eventCode> --name="<Event Name>" --date=YYYY-MM-DDThh:mm:ssZ --season=<code> --venue=<slug>',
        run: {
          script: 'scripts/04-event-management/create.js',
          args: []
        },
        description: 'Creates a new event bound to a season and venue with scheduling metadata.',
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
              name: 'venue',
              label: 'Slug du lieu',
              placeholder: 'patinoire-blagnac',
              required: true,
              arg: { type: 'option', template: '--venue=${value}' }
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
            }
          ]
        }
      },
      {
        id: 'event-set-onsale',
        label: 'Set Event On-sale',
        order: 3,
        path: 'scripts/04-event-management/set-onsale.js',
        command: 'node scripts/04-event-management/set-onsale.js --event=<slug|ObjectId> --open',
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
            },
            {
              name: 'state',
              label: 'Etat (true/false)',
              placeholder: 'true',
              arg: { type: 'option', template: '--on=${value}' }
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
            },
            {
              name: 'commit',
              label: 'Appliquer (--commit)',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--commit' }
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
        id: 'event-import-invitations',
        label: 'Import Invitations (QR)',
        order: 3.55,
        path: 'scripts/04-event-management/import-invitations-with-qr.js',
        command: 'node scripts/04-event-management/import-invitations-with-qr.js <path/to/invitations.csv> [--event=<slug|ObjectId>] [--status=paid] [--commit] [--force] [--no-finalize]',
        run: {
          script: 'scripts/04-event-management/import-invitations-with-qr.js',
          args: []
        },
        description: 'Imports external invitation tickets (with pre-generated QR codes) as paid event orders so they can be scanned by the gate app. Dry-run by default; add --commit to persist and --no-finalize to skip ticket provisioning.',
        notes: [
          'The CSV must include a QR column (qrHex / qrValue / qr / qr_code / qrcode).',
          'Provide one QR per ticket; use "|" or qr1/qr2 columns when quantity > 1.',
          'Finalize step is enabled by default to create Ticket documents immediately.'
        ],
        form: {
          fields: [
            {
              name: 'csv',
              label: 'CSV invitations',
              placeholder: 'data/inputs/event-invitations.csv',
              required: true,
              arg: { type: 'positional', index: 0 }
            },
            {
              name: 'event',
              label: 'Slug ou ID de l’événement',
              placeholder: 'match-2025-09-21-bts-vs-xxx',
              arg: { type: 'option', template: '--event=${value}' }
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
            },
            {
              name: 'append',
              label: 'Mode ajout (true|false)',
              placeholder: 'true',
              arg: { type: 'option', template: '--append=${value}' }
            }
          ]
        }
      },
      {
        id: 'event-seats-hold-release',
        label: 'Seat Holds (block/free)',
        order: 5,
        path: 'scripts/04-event-management/seats-hold-release.js',
        command: 'node scripts/04-event-management/seats-hold-release.js --event=<slug> --file=<holds.csv> [--commit] [--force]',
        run: {
          script: 'scripts/04-event-management/seats-hold-release.js',
          args: []
        },
        description: 'Blocks or frees event seat holds based on a CSV describing action, seatId/zoneKey, reason, and expiry.',
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
        command: 'node scripts/04-event-management/send-all-season-tickets-for-event.js --event=<slug> [--limit=200] [--dry-run]',
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
            },
            {
              name: 'dryRun',
              label: 'Mode test (dry-run)',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--dry-run' }
            },
            {
              name: 'force',
              label: 'Réexpédier même si déjà envoyé',
              type: 'checkbox',
              arg: { type: 'flag', flag: '--force' }
            }
          ]
        }
      },
      {
        id: 'event-resend-tickets',
        label: 'Resend Tickets for Event',
        order: 7.2,
        path: 'scripts/04-event-management/resend-event-tickets.js',
        command: 'node scripts/04-event-management/resend-event-tickets.js --event=<slug> --order=<orderId[,orderId2]> [--status=paid] [--dry-run]',
        run: {
          script: 'scripts/04-event-management/resend-event-tickets.js',
          args: []
        },
        description: 'Resends event ticket emails for specific order IDs. Use --status=paid to override and --dry-run to preview.',
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
        command: 'node scripts/04-event-management/tickets-pdf.js <orderId>',
        run: {
          script: 'scripts/04-event-management/tickets-pdf.js',
          args: []
        },
        description: 'Builds a PDF of tickets for a given order, reusing QR codes from the bank.',
        form: {
          fields: [
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
              placeholder: 'tickets.pdf',
              arg: { type: 'option', template: '--out=${value}' }
            }
          ]
        }
      }
    ]
  },
  {
    id: '05-misc',
    label: '05 — Misc',
    order: 5,
    description: 'Miscellaneous operational scripts: exports, audits, order management, and sentinels.',
    scripts: [
      {
        id: 'export-orders',
        label: 'Export Orders (CSV)',
        order: 0,
        path: 'scripts/05-misc/reports/export-orders.js',
        command: 'node scripts/05-misc/reports/export-orders.js [--season=<code>] [--venue=<slug>] [--status=paid]',
        run: {
          script: 'scripts/05-misc/reports/export-orders.js',
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
        path: 'scripts/05-misc/reports/export-seats.js',
        command: 'node scripts/05-misc/reports/export-seats.js [--season=<code>] [--venue=<slug>] [--zone=<key>]',
        run: {
          script: 'scripts/05-misc/reports/export-seats.js',
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
        path: 'scripts/05-misc/sentinels/pending-orders.js',
        command: 'node scripts/05-misc/sentinels/pending-orders.js [--max-age-minutes=60]',
        run: {
          script: 'scripts/05-misc/sentinels/pending-orders.js',
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
        path: 'scripts/05-misc/audit-missing-seats.js',
        command: 'node scripts/05-misc/audit-missing-seats.js <seasonCode> --venue=<slug>',
        run: {
          script: 'scripts/05-misc/audit-missing-seats.js',
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
