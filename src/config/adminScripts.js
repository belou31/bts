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
        description: 'Verifies the consistency of APP_URL/BASE_PATH and HelloAsso configuration for the current APP_ENV.'
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
        ]
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
        templates: ['data/templates/files/plan.svg']
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
        ]
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
        templates: ['data/templates/csv/zones.template.csv']
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
        description: 'Checks that the SVG seating plan contains the expected selectors and seat count.'
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
        templates: ['data/templates/csv/tariff-catalog.template.csv']
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
        ]
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
        templates: ['data/templates/csv/tariff-prices.template.csv']
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
        ]
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
        description: 'Produces a tariffCode × zone matrix (euros) to ease comparisons.'
      },
      {
        id: 'clone-zone-tariffs',
        label: 'Clone Zone Tariffs',
        order: 7,
        path: 'scripts/02-tariff-management/clone-zone-tariffs.mjs',
        command: 'node scripts/02-tariff-management/clone-zone-tariffs.mjs --season=<code> --venue=<slug> --from-zone=<A1> --to-zones=<B1,B2> [--discount=30]',
        run: {
          script: 'scripts/02-tariff-management/clone-zone-tariffs.mjs',
          args: []
        },
        description: 'Copies pricing from one zone to others, optionally applying a discount.'
      }
    ]
  },
  {
    id: '03-season-management',
    label: '03 — Season Management',
    order: 3,
    description: 'Season setup tasks (data seeding, subscriber imports, renewal workflows).',
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
        ]
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
        description: 'Clones seat and zone catalogs into season-specific collections. Use the skip flags to target only seats or zones.'
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
        description: 'Applies one or more tariff matrix catalogs to populate TariffPrice for the season/venue. Add --clear to purge existing rows first.'
      },
      {
        id: 'import-subscribers-flat',
        label: 'Import Subscribers (flat CSV)',
        order: 3,
        path: 'scripts/03-season-management/import-subscribers-flat.js',
        command: 'node scripts/03-season-management/import-subscribers-flat.js <path/to/subscribers.csv> <seasonCode> --venue=<slug>',
        run: {
          script: 'scripts/03-season-management/import-subscribers-flat.js',
          args: []
        },
        description: 'Loads subscribers from a simple CSV (one subscriber per row) and links seats when possible.',
        templates: ['data/templates/csv/subscribers-flat.template.csv']
      },
      {
        id: 'season-provision',
        label: 'Provision Seats (season rules)',
        order: 4,
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
      {
        id: 'renewal-provision',
        label: 'Provision Seats for Renewal',
        order: 5,
        path: 'scripts/03-season-management/renewal-provision-seats.js',
        command: 'node scripts/03-season-management/renewal-provision-seats.js <seasonCode> --venue=<slug> [--apply]',
        run: {
          script: 'scripts/03-season-management/renewal-provision-seats.js',
          args: []
        },
        description: 'Tags previous-season seats as provisioned so subscribers can renew them.',
        notes: [
          'Dry-run by default; add --apply to persist updates in MongoDB.'
        ]
      },
      {
        id: 'export-renew-groups',
        label: 'Export Renewal Tokens',
        order: 6,
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
        templates: ['data/templates/csv/renew-groups.template.csv']
      },
      {
        id: 'export-renew-seats',
        label: 'Export Renewal Seats',
        order: 7,
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
        templates: ['data/templates/csv/renew-seats.template.csv']
      }
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
        path: 'scripts/03-event-management/events/create.js',
        command: 'node scripts/03-event-management/events/create.js --slug=<eventCode> --name="<Event Name>" --date=YYYY-MM-DDThh:mm:ssZ --season=<code> --venue=<slug>',
        run: {
          script: 'scripts/03-event-management/events/create.js',
          args: []
        },
        description: 'Creates a new event bound to a season and venue with scheduling metadata.',
        notes: [
          'The script auto-generates priceTableKey=ev:<slug>; adjust afterwards if you need an existing table.'
        ]
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
        ]
      },
      {
        id: 'event-build-allowed',
        label: 'Build Allowed-From Prices',
        order: 2,
        path: 'scripts/03-event-management/events/build-allowed-from-prices.js',
        command: 'node scripts/03-event-management/events/build-allowed-from-prices.js --event=<slug> --season=<code> --venue=<slug>',
        run: {
          script: 'scripts/03-event-management/events/build-allowed-from-prices.js',
          args: []
        },
        description: 'Recomputes allowed-from pricing for an event based on zone tariffs.'
      },
      {
        id: 'event-import-qr-bank',
        label: 'Import QR Bank',
        order: 3,
        path: 'scripts/03-event-management/events/import-qr-bank.js',
        command: 'node scripts/03-event-management/events/import-qr-bank.js --event=<slug> --csv=<codes.csv> [--append]',
        run: {
          script: 'scripts/03-event-management/events/import-qr-bank.js',
          args: []
        },
        description: 'Imports QR codes for an event, grouped by tariff buckets.'
      },
      {
        id: 'event-import-tariffs',
        label: 'Import Event Tariffs',
        order: 4,
        path: 'scripts/03-event-management/events/import-tariffs.js',
        command: 'node scripts/03-event-management/events/import-tariffs.js --event=<slug> --tariffs=<catalog.csv> --zoneprices=<prices.csv>',
        run: {
          script: 'scripts/03-event-management/events/import-tariffs.js',
          args: []
        },
        description: 'Loads event-specific tariffs and price tables from CSV files.'
      },
      {
        id: 'event-seats-hold-release',
        label: 'Seat Holds (block/free)',
        order: 5,
        path: 'scripts/04-event-management/seats-hold-release.js',
        command: 'node scripts/04-event-management/seats-hold-release.js --file=<holds.csv> [--commit] [--force]',
        run: {
          script: 'scripts/04-event-management/seats-hold-release.js',
          args: []
        },
        description: 'Blocks or frees event seat holds based on a CSV describing action, eventId, seatId/zoneKey, reason, and expiry.',
        notes: [
          'Without --commit the script runs in dry-run mode; add --force to overwrite existing holds.'
        ],
        templates: ['data/templates/csv/seats-hold-release.template.csv']
      },
      {
        id: 'event-send-season-tickets',
        label: 'Send Season Tickets (PDF)',
        order: 6,
        path: 'scripts/03-event-management/events/send-season-tickets-for-event.js',
        command: 'node scripts/03-event-management/events/send-season-tickets-for-event.js --event=<slug> [--limit=200] [--dry-run]',
        run: {
          script: 'scripts/03-event-management/events/send-season-tickets-for-event.js',
          args: []
        },
        description: 'Generates and emails season tickets for a specific event, optionally in dry-run mode.'
      },
      {
        id: 'event-tickets-pdf',
        label: 'Generate Tickets PDF',
        order: 7,
        path: 'scripts/03-event-management/events/tickets-pdf.js',
        command: 'node scripts/03-event-management/events/tickets-pdf.js <orderId>',
        run: {
          script: 'scripts/03-event-management/events/tickets-pdf.js',
          args: []
        },
        description: 'Builds a PDF of tickets for a given order, reusing QR codes from the bank.'
      }
    ]
  },
  {
    id: '05-admin-monitoring',
    label: '05 — Admin & Monitoring',
    order: 5,
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
        ]
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
        ]
      },
      {
        id: 'export-seats',
        label: 'Export Seats (CSV)',
        order: 3,
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
        order: 4,
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
        order: 5,
        path: 'scripts/04-admin-monitoring/orders-resend-confirmation.js',
        command: 'node scripts/04-admin-monitoring/orders-resend-confirmation.js --file=orders.csv [--commit]',
        run: {
          script: 'scripts/04-admin-monitoring/orders-resend-confirmation.js',
          args: []
        },
        description: 'Resends the HelloAsso confirmation email for a specific order.',
        templates: ['data/templates/csv/orders-resend.template.csv'],
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
        ]
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
        ]
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
