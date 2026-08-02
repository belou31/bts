#!/usr/bin/env python3
"""
BTS local command line — posts the same jobs the LibreOffice/Excel macros do,
reading CSV files from disk instead of spreadsheet cells. Uses the shared
`automation_client` package for config resolution, JWT signing, and HTTP.

Usage:
    python3 scripts_desktop/cli/bts_cli.py list
    python3 scripts_desktop/cli/bts_cli.py tariff import-catalog data/inputs/tariff_catalog.csv
    python3 scripts_desktop/cli/bts_cli.py tariff export-catalog --out=data/outputs/tariff_catalog.csv
    python3 scripts_desktop/cli/bts_cli.py tariff import-prices season-game data/inputs/prices.csv --venue=patinoire-blagnac
    python3 scripts_desktop/cli/bts_cli.py season send-renew-invites data/inputs/renew-groups.csv --season=2025-2026
    python3 scripts_desktop/cli/bts_cli.py event import-orders data/inputs/event-orders.csv --commit
    python3 scripts_desktop/cli/bts_cli.py jobs status <job-id>

Don't know what's available? Run `list` — it queries the live automation API
(GET /api/automation/scripts) rather than a hardcoded list, so it can never
drift from what the server actually supports.

Environment: same as the LibreOffice macros (BTS_BASE_URL, AUTOMATION_JWT_SECRET,
AUTOMATION_JWT_ISS/AUD/SCOPES), loaded from ~/.config/bts/automation.env if present.
"""

from __future__ import annotations

import argparse
import csv
import getpass
import inspect
import sys
from pathlib import Path
from typing import Any, Dict, List


def _module_dir() -> Path:
    try:
        return Path(__file__).resolve().parent
    except NameError:
        frame = inspect.currentframe()
        if frame is None:
            raise
        return Path(inspect.getfile(frame)).resolve().parent


try:
    from automation_client import (
        AutomationClient,
        AutomationConfig,
        AutomationError,
        ensure_env_loaded,
        parse_bool,
    )
except ImportError:
    repo_root = _module_dir().parent.parent  # scripts_desktop/cli/ -> scripts_desktop/ -> repo root
    if str(repo_root) not in sys.path:
        sys.path.append(str(repo_root))
    from automation_client import (  # type: ignore
        AutomationClient,
        AutomationConfig,
        AutomationError,
        ensure_env_loaded,
        parse_bool,
    )

ensure_env_loaded()

INTEGRATION = 'bts-cli'


def _requested_by() -> str:
    return f'{getpass.getuser()}@bts-cli'


def _client(*, default_scopes) -> AutomationClient:
    config = AutomationConfig.from_env(default_issuer='bts-cli', default_scopes=default_scopes)
    return AutomationClient(config, integration=INTEGRATION, requested_by=_requested_by)


def _read_csv(path: str) -> List[Dict[str, str]]:
    csv_path = Path(path)
    if not csv_path.exists():
        raise SystemExit(f'CSV not found: {path}')
    with csv_path.open('r', encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        return [
            {(key or '').strip().lower(): (value or '').strip() for key, value in row.items()}
            for row in reader
        ]


def _resolve_dry_run(args: argparse.Namespace, *, default: bool) -> bool:
    if args.dry_run:
        return True
    if args.commit:
        return False
    return default


def _print_job_result(response: Dict[str, Any]) -> None:
    job = response.get('job', {})
    print(f"Job {job.get('id', 'unknown')} — status: {job.get('status', 'queued')}")
    summary = job.get('summary')
    if summary:
        print(f'Summary: {summary}')


def _add_dry_run_args(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--dry-run', action='store_true', help='Force dry-run, regardless of the task default.')
    group.add_argument('--commit', action='store_true', help='Force a live run, regardless of the task default.')


# === tariff import-catalog ==================================================

def cmd_tariff_import_catalog(args: argparse.Namespace) -> None:
    rows = _read_csv(args.csv)
    entries = []
    for row in rows:
        code = (row.get('code') or '').upper()
        label = row.get('label') or ''
        if not code or not label:
            continue
        entries.append({
            'code': code,
            'label': label,
            'requiresField': row.get('requiresfield') or row.get('requires_field') or '',
            'fieldLabel': row.get('fieldlabel') or row.get('field_label') or '',
            'requiresInfo': row.get('requiresinfo') or row.get('requires_info') or '',
            'active': parse_bool(row.get('active') or row.get('enabled'), True),
            'sortOrder': row.get('sortorder') or row.get('sort_order') or '',
            'channels': row.get('channels') or row.get('channel') or row.get('scopes') or '',
        })
    if not entries:
        raise SystemExit('No valid rows (code + label) found in CSV.')

    dry_run = _resolve_dry_run(args, default=False)
    payload = {
        'dryRun': dry_run,
        'entries': entries,
        'metadata': {'source': 'bts-cli', 'csv': str(Path(args.csv).resolve())},
    }
    client = _client(default_scopes=('automation:jobs:write', 'automation:jobs:run'))
    try:
        response = client.post_job('scripts/tariff.import-catalog/jobs', payload)
    except AutomationError as err:
        raise SystemExit(f'Import failed: {err}')
    _print_job_result(response)


# === tariff export-catalog ==================================================

def cmd_tariff_export_catalog(args: argparse.Namespace) -> None:
    client = _client(default_scopes=('automation:jobs:write', 'automation:jobs:run'))
    try:
        response = client.post_job('scripts/tariff.export-catalog/jobs', {'runMode': 'sync'})
    except AutomationError as err:
        raise SystemExit(f'Export failed: {err}')

    job = response.get('job', {})
    if job.get('status') != 'succeeded':
        error = job.get('error') or {}
        raise SystemExit(f"Export failed: {error.get('message', job.get('status', 'unknown error'))}")

    entries = ((job.get('result') or {}).get('payload') or {}).get('entries', [])
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ['code', 'label', 'requiresField', 'fieldLabel', 'requiresInfo', 'active', 'sortOrder', 'channels']
    with out_path.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for entry in entries:
            row = {key: entry.get(key, '') for key in fieldnames}
            row['active'] = 'true' if entry.get('active') else 'false'
            writer.writerow(row)
    print(f'Exported {len(entries)} tariff(s) -> {out_path.resolve()}')


# === tariff export-zone-tariffs =============================================

def cmd_tariff_export_zone_tariffs(args: argparse.Namespace) -> None:
    client = _client(default_scopes=('automation:jobs:write', 'automation:jobs:run'))
    payload = {
        'runMode': 'sync',
        'params': {'seasonCode': args.season, 'venueSlug': args.venue},
    }
    try:
        response = client.post_job('scripts/tariff.export-zone-tariffs/jobs', payload)
    except AutomationError as err:
        raise SystemExit(f'Export failed: {err}')

    job = response.get('job', {})
    if job.get('status') != 'succeeded':
        error = job.get('error') or {}
        raise SystemExit(f"Export failed: {error.get('message', job.get('status', 'unknown error'))}")

    entries = ((job.get('result') or {}).get('payload') or {}).get('entries', [])
    out_path = Path(args.out or f'prices-{args.season}-{args.venue}.csv')
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ['zoneKey', 'tariffCode', 'priceCents', 'priceEuro', 'partnerPriceCents', 'partnerPriceEuro', 'currency']
    with out_path.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for entry in entries:
            writer.writerow({key: entry.get(key, '') for key in fieldnames})
    print(f'Exported {len(entries)} row(s) -> {out_path.resolve()}')


# === tariff import-prices ===================================================

def cmd_tariff_import_prices(args: argparse.Namespace) -> None:
    rows = _read_csv(args.csv)
    entries = []
    for row in rows:
        catalog_slug = (row.get('catalogslug') or row.get('catalog') or args.catalog_slug or '').lower()
        zone_key = (row.get('zonekey') or row.get('zone') or '').upper()
        tariff_code = (row.get('tariffcode') or row.get('tariff') or row.get('code') or '').upper()
        if not catalog_slug or not zone_key or not tariff_code:
            continue
        entries.append({
            'catalogSlug': catalog_slug,
            'venueSlug': (row.get('venueslug') or args.venue or None),
            'zoneKey': zone_key,
            'tariffCode': tariff_code,
            'priceCents': row.get('pricecents') or '',
            'priceEuro': row.get('priceeuro') or row.get('price') or '',
            'currency': row.get('currency') or 'EUR',
            'channels': row.get('channels') or row.get('channel') or row.get('scopes') or '',
        })
    if not entries:
        raise SystemExit('No valid rows (catalogSlug, zoneKey, tariffCode, price) found in CSV.')

    dry_run = _resolve_dry_run(args, default=True)
    payload = {
        'dryRun': dry_run,
        'append': args.append,
        'entries': entries,
        'catalogSlug': args.catalog_slug or None,
        'venueSlug': args.venue or None,
        'metadata': {'source': 'bts-cli', 'csv': str(Path(args.csv).resolve())},
    }
    client = _client(default_scopes=('automation:jobs:write', 'automation:jobs:run', 'automation:events:write'))
    try:
        response = client.post_job('scripts/tariff.import-prices/jobs', payload)
    except AutomationError as err:
        raise SystemExit(f'Import failed: {err}')
    _print_job_result(response)


# === season send-renew-invites ==============================================

def cmd_season_send_renew_invites(args: argparse.Namespace) -> None:
    rows = _read_csv(args.csv)
    invitees = []
    for row in rows:
        email = row.get('email') or ''
        renew_url = row.get('renewurl') or ''
        if not email or not renew_url:
            continue
        invitees.append({
            'email': email,
            'renewUrl': renew_url,
            'firstName': row.get('firstname') or '',
            'lastName': row.get('lastname') or '',
            'seats': row.get('seats') or '',
        })
    if not invitees:
        raise SystemExit('No valid invitations (email + renewUrl) found in CSV.')

    dry_run = _resolve_dry_run(args, default=False)
    payload = {
        'dryRun': dry_run,
        'params': {
            'csv': 'bts-cli',
            'template': 'renew-invite',
            'subject': args.subject,
            'seasonCode': args.season,
            'deadline': args.deadline or '',
            'providerLabel': args.provider_label,
            'invitees': invitees,
        },
        'metadata': {'source': 'bts-cli', 'csv': str(Path(args.csv).resolve())},
    }
    client = _client(default_scopes=('automation:jobs:write', 'automation:jobs:run'))
    try:
        response = client.post_job('scripts/season.send-renew-invites/jobs', payload)
    except AutomationError as err:
        raise SystemExit(f'Send failed: {err}')
    _print_job_result(response)


# === event import-orders ====================================================

def _to_int(value: str, default):
    if value is None or value == '':
        return default
    try:
        return int(round(float(value.replace(',', '.'))))
    except (TypeError, ValueError):
        return default


def cmd_event_import_orders(args: argparse.Namespace) -> None:
    rows = _read_csv(args.csv)
    orders: Dict[str, Dict[str, Any]] = {}

    for row in rows:
        payer_email = row.get('payeremail') or ''
        event_slug = row.get('eventslug') or ''
        event_id = row.get('eventid') or ''
        zone_key = row.get('zonekey') or ''
        seat_id = row.get('seatid') or ''
        if not payer_email or (not event_slug and not event_id):
            continue
        if not zone_key and not seat_id:
            continue

        order_id = row.get('orderid') or ''
        group_key = row.get('groupkey') or order_id
        if not group_key:
            seq = len(orders) + 1
            group_key = f"{payer_email.lower()}::{event_slug or event_id or 'event'}::{seq}"

        if group_key not in orders:
            orders[group_key] = {
                'orderId': order_id or None,
                'groupKey': group_key,
                'eventId': event_id or None,
                'eventSlug': event_slug or None,
                'payerEmail': payer_email,
                'payerFirstName': row.get('payerfirstname') or '',
                'payerLastName': row.get('payerlastname') or '',
                'seasonCode': row.get('seasoncode') or '',
                'venueSlug': row.get('venueslug') or '',
                'status': row.get('status') or 'paid',
                'totalCents': _to_int(row.get('totalcents'), 0),
                'paymentSplit': _to_int(row.get('paymentsplit'), 1),
                'lines': [],
            }

        order = orders[group_key]
        price_value = _to_int(row.get('pricecents'), None)
        if price_value is None or price_value <= 0:
            euros = _to_int(row.get('priceeuro') or row.get('price'), None)
            if euros is not None and euros > 0:
                price_value = int(round(euros * 100))
        if price_value is None or price_value < 0:
            price_value = 0

        quantity = max(1, _to_int(row.get('quantity'), 1))
        order['lines'].append({
            'seatId': seat_id,
            'zoneKey': zone_key,
            'tariffCode': (row.get('tariffcode') or row.get('tariff') or '').upper(),
            'priceCents': price_value,
            'quantity': quantity,
            'holderFirstName': row.get('holderfirstname') or '',
            'holderLastName': row.get('holderlastname') or '',
        })

    result = []
    for order in orders.values():
        if not order['lines']:
            continue
        if order['totalCents'] <= 0:
            order['totalCents'] = sum(
                int(line['priceCents']) * int(line['quantity']) for line in order['lines']
            )
        result.append(order)

    if not result:
        raise SystemExit('No valid orders (payerEmail + eventSlug/eventId + zoneKey/seatId) found in CSV.')

    dry_run = _resolve_dry_run(args, default=True)
    payload = {
        'dryRun': dry_run,
        'force': args.force,
        'sendEmail': args.send_email,
        'orders': result,
        'metadata': {'source': 'bts-cli', 'csv': str(Path(args.csv).resolve())},
    }
    client = _client(default_scopes=('automation:jobs:write', 'automation:jobs:run', 'automation:events:write'))
    try:
        response = client.post_job('scripts/event.import-orders/jobs', payload)
    except AutomationError as err:
        raise SystemExit(f'Import failed: {err}')
    _print_job_result(response)


# === jobs status =============================================================

def cmd_jobs_status(args: argparse.Namespace) -> None:
    client = _client(default_scopes=('automation:jobs:read',))
    try:
        response = client.get_job(args.job_id)
    except AutomationError as err:
        raise SystemExit(f'Lookup failed: {err}')
    job = response.get('job', {})
    print(f"Job {job.get('id', args.job_id)} — status: {job.get('status', 'unknown')}")
    summary = job.get('summary')
    if summary:
        print(f'Summary: {summary}')
    for entry in job.get('logs') or []:
        print(f"  {entry}")


# === list ====================================================================

def _subparser_choices(parser: argparse.ArgumentParser) -> Dict[str, argparse.ArgumentParser]:
    for action in parser._actions:  # noqa: SLF001 — no public API for this in argparse
        if isinstance(action, argparse._SubParsersAction):  # noqa: SLF001
            return action.choices
    return {}


def cmd_list(args: argparse.Namespace) -> None:
    client = _client(default_scopes=('automation:jobs:read',))
    try:
        response = client.list_scripts()
    except AutomationError as err:
        raise SystemExit(f'Could not reach the automation API: {err}')

    top_level_choices = _subparser_choices(args.parser)
    by_chapter: Dict[str, List[tuple]] = {}
    for script in response.get('scripts', []):
        task_id = script.get('id', '')
        group, _, action_name = task_id.partition('.')
        cli_cmd = f'{group} {action_name}' if action_name else group
        group_parser = top_level_choices.get(group)
        available = group_parser is not None and action_name in _subparser_choices(group_parser)
        chapter = script.get('chapter') or 'Other'
        by_chapter.setdefault(chapter, []).append((cli_cmd, script.get('summary', ''), available))

    if not by_chapter:
        print('No automation scripts registered on the server.')
        return

    for chapter in sorted(by_chapter):
        print(chapter)
        for cli_cmd, summary, available in sorted(by_chapter[chapter]):
            note = '' if available else '  [not available via bts_cli — call the API/macro directly]'
            print(f'  bts_cli.py {cli_cmd:<28} {summary}{note}')
        print()


# === argument parser =========================================================

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='bts_cli.py',
        description='BTS local command line — posts jobs to the BTS automation API from CSV files.',
    )
    subparsers = parser.add_subparsers(dest='group', required=True)

    tariff = subparsers.add_parser('tariff', help='Tariff catalog / prices import')
    tariff_sub = tariff.add_subparsers(dest='action', required=True)

    p = tariff_sub.add_parser('import-catalog', help='Import the tariff catalog from a CSV (dryRun=false by default).')
    p.add_argument('csv', help='Path to a CSV with headers: code,label,requiresField,fieldLabel,requiresInfo,active,sortOrder,channels')
    _add_dry_run_args(p)
    p.set_defaults(func=cmd_tariff_import_catalog)

    p = tariff_sub.add_parser('export-catalog', help='Export the tariff catalog to a CSV file.')
    p.add_argument('--out', default='tariff_catalog.csv', help='Output CSV path (default: tariff_catalog.csv in the current directory).')
    p.set_defaults(func=cmd_tariff_export_catalog)

    p = tariff_sub.add_parser('export-zone-tariffs', help='Export zone prices for a season/venue to a CSV file.')
    p.add_argument('season', help='Season code, e.g. 2025-2026.')
    p.add_argument('venue', help='Venue slug, e.g. patinoire-blagnac.')
    p.add_argument('--out', default=None, help='Output CSV path (default: prices-<season>-<venue>.csv in the current directory).')
    p.set_defaults(func=cmd_tariff_export_zone_tariffs)

    p = tariff_sub.add_parser('import-prices', help='Import tariff prices from a CSV (dryRun=true by default).')
    p.add_argument('catalog_slug', help='Default catalogSlug when the CSV omits the column.')
    p.add_argument('csv', help='Path to a CSV with headers: catalogSlug,venueSlug,zoneKey,tariffCode,priceCents/priceEuro,currency,channels')
    p.add_argument('--venue', default=None, help='Default venueSlug when the CSV omits the column.')
    p.add_argument('--append', action='store_true', help='Append instead of replacing existing prices.')
    _add_dry_run_args(p)
    p.set_defaults(func=cmd_tariff_import_prices)

    season = subparsers.add_parser('season', help='Season / renewal workflows')
    season_sub = season.add_subparsers(dest='action', required=True)

    p = season_sub.add_parser('send-renew-invites', help='Send renewal invitation emails (dryRun=false by default).')
    p.add_argument('csv', help='Path to a CSV with headers: email,renewUrl,firstName,lastName,seats')
    p.add_argument('--subject', default='Renouvellement d’abonnement')
    p.add_argument('--season', default='', dest='season')
    p.add_argument('--deadline', default='')
    p.add_argument('--provider-label', default='HelloAsso')
    _add_dry_run_args(p)
    p.set_defaults(func=cmd_season_send_renew_invites)

    event = subparsers.add_parser('event', help='Event order import')
    event_sub = event.add_subparsers(dest='action', required=True)

    p = event_sub.add_parser('import-orders', help='Import event orders from a CSV (dryRun=true by default).')
    p.add_argument('csv', help='Path to a CSV with headers matching the LibreOffice/Excel EventOrders sheet.')
    p.add_argument('--force', action='store_true', help='Overwrite already-booked seats.')
    p.add_argument('--send-email', action='store_true', help='Send confirmation/payment-link emails.')
    _add_dry_run_args(p)
    p.set_defaults(func=cmd_event_import_orders)

    jobs = subparsers.add_parser('jobs', help='Inspect previously submitted jobs')
    jobs_sub = jobs.add_subparsers(dest='action', required=True)

    p = jobs_sub.add_parser('status', help='Print the current status/log of a job.')
    p.add_argument('job_id')
    p.set_defaults(func=cmd_jobs_status)

    p = subparsers.add_parser(
        'list',
        help='List automation scripts callable from this CLI, grouped by chapter (queries the live API).',
    )
    p.set_defaults(func=cmd_list)

    return parser


def main(argv: List[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.parser = parser
    args.func(args)


if __name__ == '__main__':
    main()
