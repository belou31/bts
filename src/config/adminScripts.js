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
    label: '00 — Baseline & Reset',
    order: 0,
    description: 'Foundation tasks that prepare a clean database or environment prior to provisioning data.',
    scripts: [
      {
        id: 'reset-db',
        label: 'Reset MongoDB Database',
        order: 0,
        path: 'scripts/00-baseline-reset/reset-db.js',
        command: 'node scripts/00-baseline-reset/reset-db.js --force',
        run: {
          script: 'scripts/00-baseline-reset/reset-db.js',
          args: ['--force']
        },
        description: 'Drops the MongoDB database defined in .env. Requires the --force flag to avoid accidental wipes.',
        danger: true,
        templates: ['data/templates/env/.env.template'],
        notes: [
          'Make sure the MongoDB URI points to the intended environment before running.',
          'Include --force to acknowledge the drop command.'
        ]
      }
    ]
  },
  {
    id: '01-initialization',
    label: '01 — Initialization (DB, Venue, Season)',
    order: 1,
    description: 'First-time setup scripts that prepare the venue, seats, base tariffs, and subscribers.',
    scripts: [
      {
        id: 'check-env',
        label: 'Validate Environment (.env)',
        order: 0,
        path: 'scripts/01-initialization/check-env.js',
        command: 'node scripts/01-initialization/check-env.js',
        run: {
          script: 'scripts/01-initialization/check-env.js',
          args: []
        },
        description: 'Verifies the consistency of APP_URL/BASE_PATH and HelloAsso configuration for the current APP_ENV.',
        templates: ['data/templates/env/.env.template']
      },
      {
        id: 'seed-dev',
        label: 'Seed Development Dataset',
        order: 1,
        path: 'scripts/01-initialization/seed-dev.js',
        command: 'node scripts/01-initialization/seed-dev.js',
        run: {
          script: 'scripts/01-initialization/seed-dev.js',
          args: []
        },
        description: 'Seeds a minimal development dataset (season, zones, seats, price tables, TBH7 campaign).',
        templates: ['data/templates/env/.env.template']
      },
      {
        id: 'seed-zones',
        label: 'Import Zones from CSV',
        order: 2,
        path: 'scripts/01-initialization/seed-zones.js',
        command: 'node scripts/01-initialization/seed-zones.js --csv=<path/to/zones.csv> --venue=<slug>',
        run: {
          script: 'scripts/01-initialization/seed-zones.js',
          args: []
        },
        description: 'Upserts zones for the target venue and season from a CSV file.',
        templates: [
          'data/templates/env/.env.template',
          'data/templates/csv/zones.template.csv'
        ]
      },
      {
        id: 'register-venue',
        label: 'Register Venue',
        order: 3,
        path: 'scripts/01-initialization/venues/register-venue.js',
        command: 'node scripts/01-initialization/venues/register-venue.js <slug> "<Venue Name>"',
        run: {
          script: 'scripts/01-initialization/venues/register-venue.js',
          args: []
        },
        description: 'Creates a new venue document with the provided slug and display name.',
        templates: [
          'data/templates/env/.env.template'
        ]
      },
      {
        id: 'register-venue-with-plan',
        label: 'Register Venue (with plan import)',
        order: 4,
        path: 'scripts/01-initialization/venues/register-venue-with-plan.js',
        command: 'node scripts/01-initialization/venues/register-venue-with-plan.js <slug> "<Venue Name>" <path/to/plan.svg>',
        run: {
          script: 'scripts/01-initialization/venues/register-venue-with-plan.js',
          args: []
        },
        description: 'Registers a venue and stores the seating plan SVG in one pass.',
        templates: [
          'data/templates/env/.env.template',
          'data/templates/files/plan.svg'
        ]
      },
      {
        id: 'import-seats',
        label: 'Import Seats from SVG',
        order: 5,
        path: 'scripts/01-initialization/venues/import-seats-from-svg.js',
        command: 'node scripts/01-initialization/venues/import-seats-from-svg.js <venueSlug> <path/to/plan.svg>',
        run: {
          script: 'scripts/01-initialization/venues/import-seats-from-svg.js',
          args: []
        },
        description: 'Parses the venue plan SVG and imports seats into MongoDB.',
        templates: [
          'data/templates/env/.env.template',
          'data/templates/files/plan.svg'
        ]
      },
      {
        id: 'instantiate-seats',
        label: 'Instantiate Seats for Season',
        order: 6,
        path: 'scripts/01-initialization/venues/instantiate-seats-for-season.js',
        command: 'node scripts/01-initialization/venues/instantiate-seats-for-season.js <seasonCode> <venueSlug>',
        run: {
          script: 'scripts/01-initialization/venues/instantiate-seats-for-season.js',
          args: []
        },
        description: 'Clones base venue seats into a season-specific collection with default availability.',
        templates: ['data/templates/env/.env.template']
      },
      {
        id: 'import-subscribers-flat',
        label: 'Import Subscribers (flat CSV)',
        order: 7,
        path: 'scripts/01-initialization/import-subscribers-flat.js',
        command: 'node scripts/01-initialization/import-subscribers-flat.js <path/to/subscribers.csv> <seasonCode> --venue=<slug>',
        run: {
          script: 'scripts/01-initialization/import-subscribers-flat.js',
          args: []
        },
        description: 'Loads subscribers from a simple CSV (one subscriber per row) and links seats when possible.',
        templates: [
          'data/templates/env/.env.template',
          'data/templates/csv/subscribers-flat.template.csv'
        ]
      }
    ]
  },
  {
    id: '02-season-generation',
    label: '02 — Season Generation & Renewal',
    order: 2,
    description: 'Scripts that prepare and manage renewal campaigns for a given season.',
    scripts: [
      {
        id: 'upsert-season',
        label: 'Upsert Season & Phases',
        order: 0,
        path: 'scripts/02-season-generation/upsert-season.js',
        command: 'node scripts/02-season-generation/upsert-season.js <seasonCode> --name="<Display Name>" [--venue=<slug>] [--enable-renewal]',
        run: {
          script: 'scripts/02-season-generation/upsert-season.js',
          args: []
        },
        description: 'Creates or updates a season document and optionally toggles renewal/public phases.',
        notes: [
          'Use --enable-<phase>/--disable-<phase> and --<phase>-open=ISO / --<phase>-close=ISO to manage scheduling.'
        ],
        templates: ['data/templates/env/.env.template']
      },
      {
        id: 'renewal-provision',
        label: 'Provision Seats for Renewal',
        order: 1,
        path: 'scripts/02-season-generation/renewal/provision-seats.js',
        command: 'node scripts/02-season-generation/renewal/provision-seats.js <seasonCode> --venue=<slug> [--apply]',
        run: {
          script: 'scripts/02-season-generation/renewal/provision-seats.js',
          args: []
        },
        description: 'Prepares renewal seat allocations and tags subscribers, apply changes with --apply.',
        notes: [
          'Dry-run by default; add --apply to persist updates in MongoDB.'
        ],
        templates: ['data/templates/env/.env.template']
      },
      {
        id: 'export-renew-groups',
        label: 'Export Renewal Tokens',
        order: 2,
        path: 'scripts/02-season-generation/exports/export-renew-groups.js',
        command: 'node scripts/02-season-generation/exports/export-renew-groups.js <seasonCode> --venue=<slug> --base=<https://host/bts> --out=<file.csv>',
        run: {
          script: 'scripts/02-season-generation/exports/export-renew-groups.js',
          args: []
        },
        description: 'Generates renewal tokens grouped by subscriber, exporting a CSV ready for emailing.',
        notes: [
          'Requires JWT_SECRET and a public base URL (use --base to override APP_URL).',
          'Résultats déposés par défaut dans data/outputs.'
        ],
        templates: [
          'data/templates/env/.env.template',
          'data/templates/csv/renew-groups.template.csv'
        ]
      },
      {
        id: 'export-renew-seats',
        label: 'Export Renewal Seats',
        order: 3,
        path: 'scripts/02-season-generation/exports/export-renew-seats.js',
        command: 'node scripts/02-season-generation/exports/export-renew-seats.js <seasonCode> --venue=<slug> --out=<file.csv>',
        run: {
          script: 'scripts/02-season-generation/exports/export-renew-seats.js',
          args: []
        },
        description: 'Exports the list of seats involved in the renewal campaign for auditing.',
        notes: [
          'Supports filters (--email, --group) and token expiration via --expires (ex: 30d).',
          'Fichier généré dans data/outputs (nom par défaut basé sur la saison).'
        ],
        templates: [
          'data/templates/env/.env.template',
          'data/templates/csv/renew-seats.template.csv'
        ]
      }
    ]
  },
  {
    id: '03-event-management',
    label: '03 — Event Management & Tariffs',
    order: 3,
    description: 'Scripts that create events, control ticket sales, and manage tariff matrices.',
    scripts: [
      {
        id: 'event-create',
        label: 'Create Event',
        order: 0,
        path: 'scripts/03-event-management/events/create.js',
        command: 'node scripts/03-event-management/events/create.js --slug=<eventCode> --name="<Event Name>" --date=YYYY-MM-DDThh:mm:ssZ --season=<code> --venue=<slug>',
        run: {
          script: 'scripts/03-event-management/events/create.js',
          args: []
        },
        description: 'Creates a new event bound to a season and venue with scheduling metadata.',
        notes: [
          'The script auto-generates priceTableKey=ev:<slug>; adjust afterwards if you need an existing table.'
        ],
        templates: ['data/templates/env/.env.template']
      },
      {
        id: 'event-set-onsale',
        label: 'Set Event On-sale',
        order: 1,
        path: 'scripts/03-event-management/events/set-onsale.js',
        command: 'node scripts/03-event-management/events/set-onsale.js --event=<slug|ObjectId> --open',
        run: {
          script: 'scripts/03-event-management/events/set-onsale.js',
          args: []
        },
        description: 'Opens or closes ticket sales for an event (use --open / --close / --on=true|false).',
        notes: [
          'Accepts either the event slug or its MongoDB ObjectId.'
        ],
        templates: ['data/templates/env/.env.template']
      },
      {
        id: 'import-tariff-catalog',
        label: 'Import Tariff Catalog',
        order: 2,
        path: 'scripts/03-event-management/tariffs/import-catalog.js',
        command: 'node scripts/03-event-management/tariffs/import-catalog.js <path/to/tariff_catalog.csv>',
        run: {
          script: 'scripts/03-event-management/tariffs/import-catalog.js',
          args: []
        },
        description: 'Imports the master tariff catalog (code, label, justification requirements).',
        notes: [
          'Columns: code,label,requiresField,fieldLabel,requiresInfo,sortOrder,active.'
        ],
        templates: ['data/templates/csv/tariff-catalog.template.csv']
      },
      {
        id: 'import-zone-tariffs',
        label: 'Import Zone Tariffs',
        order: 3,
        path: 'scripts/03-event-management/pricing/import-zone-tariffs.js',
        command: 'node scripts/03-event-management/pricing/import-zone-tariffs.js <seasonCode> <venueSlug> <path/to/prices.csv>',
        run: {
          script: 'scripts/03-event-management/pricing/import-zone-tariffs.js',
          args: []
        },
        description: 'Imports the price matrix per zone for the given season/venue.',
        notes: [
          'Supports list and matrix CSV formats; override detection with --format=list|matrix.'
        ],
        templates: ['data/templates/csv/zone-tariffs.template.csv']
      },
      {
        id: 'export-zone-tariffs',
        label: 'Export Zone Tariffs',
        order: 4,
        path: 'scripts/03-event-management/pricing/export-zone-tariffs.js',
        command: 'node scripts/03-event-management/pricing/export-zone-tariffs.js <seasonCode> <venueSlug> --out=<file.csv>',
        run: {
          script: 'scripts/03-event-management/pricing/export-zone-tariffs.js',
          args: []
        },
        description: 'Exports the price matrix for verification or sharing.',
        notes: [
          'Default filename is prices.csv; override with --out=<file>. Les exports sont déposés dans data/outputs.'
        ],
        templates: ['data/templates/env/.env.template']
      }
    ]
  },
  {
    id: '04-admin-monitoring',
    label: '04 — Admin & Monitoring',
    order: 4,
    description: 'Day-to-day operational scripts: exports, audits, order management, and sentinels.',
    scripts: [
      {
        id: 'export-orders',
        label: 'Export Orders (CSV)',
        order: 0,
        path: 'scripts/04-admin-monitoring/reports/export-orders.js',
        command: 'node scripts/04-admin-monitoring/reports/export-orders.js [--season=<code>] [--venue=<slug>] [--status=paid]',
        run: {
          script: 'scripts/04-admin-monitoring/reports/export-orders.js',
          args: []
        },
        description: 'Streams orders to CSV using the shared exports service.',
        notes: [
          'Writes to stdout; redirect to a file if you need a persistent export.'
        ],
        templates: ['data/templates/csv/orders-export.template.csv']
      },
      {
        id: 'export-seats',
        label: 'Export Seats (CSV)',
        order: 1,
        path: 'scripts/04-admin-monitoring/reports/export-seats.js',
        command: 'node scripts/04-admin-monitoring/reports/export-seats.js [--season=<code>] [--venue=<slug>] [--zone=<key>]',
        run: {
          script: 'scripts/04-admin-monitoring/reports/export-seats.js',
          args: []
        },
        description: 'Streams seats with provisioning and booking metadata to CSV.',
        notes: [
          'Combines seat availability with latest paid order info for each seat.'
        ],
        templates: ['data/templates/csv/seats-export.template.csv']
      },
      {
        id: 'export-subscribers',
        label: 'Export Subscribers (CSV)',
        order: 2,
        path: 'scripts/04-admin-monitoring/reports/export-subscribers.js',
        command: 'node scripts/04-admin-monitoring/reports/export-subscribers.js <seasonCode> --venue=<slug> --out=<file.csv>',
        run: {
          script: 'scripts/04-admin-monitoring/reports/export-subscribers.js',
          args: []
        },
        description: 'Exports subscribers for a given season/venue.',
        notes: [
          'Add --activeOnly to filter active subscribers (isActive=1).'
        ],
        templates: ['data/templates/csv/subscribers-export.template.csv']
      },
      {
        id: 'orders-resend-confirmation',
        label: 'Resend Order Confirmation',
        order: 3,
        path: 'scripts/04-admin-monitoring/orders-resend-confirmation.js',
        command: 'node scripts/04-admin-monitoring/orders-resend-confirmation.js <orderId>',
        run: {
          script: 'scripts/04-admin-monitoring/orders-resend-confirmation.js',
          args: []
        },
        description: 'Resends the HelloAsso confirmation email for a specific order.',
        templates: [
          'data/templates/env/.env.template',
          'data/templates/csv/orders-resend.template.csv'
        ],
        notes: [
          'Dry-run unless --commit is provided.'
        ]
      },
      {
        id: 'pending-orders-sentinel',
        label: 'Sentinel: Pending Orders',
        order: 4,
        path: 'scripts/04-admin-monitoring/sentinels/pending-orders.js',
        command: 'node scripts/04-admin-monitoring/sentinels/pending-orders.js [--max-age-minutes=60]',
        run: {
          script: 'scripts/04-admin-monitoring/sentinels/pending-orders.js',
          args: []
        },
        description: 'Reports orders stuck in pending state beyond the expected delay.',
        notes: [
          'Use --sinceMinutes to widen the scan window; defaults to 180 minutes.'
        ],
        templates: ['data/templates/env/.env.template']
      },
      {
        id: 'audit-missing-seats',
        label: 'Audit Missing Seats',
        order: 5,
        path: 'scripts/04-admin-monitoring/audit-missing-seats.js',
        command: 'node scripts/04-admin-monitoring/audit-missing-seats.js <seasonCode> --venue=<slug>',
        run: {
          script: 'scripts/04-admin-monitoring/audit-missing-seats.js',
          args: []
        },
        description: 'Checks for discrepancies between seat provisioning and subscriptions.',
        notes: [
          'Produces detailed and grouped CSV outputs; configure --out and --grouped paths as needed.',
          'Les fichiers sont écrits par défaut dans data/outputs.'
        ],
        templates: ['data/templates/env/.env.template']
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
