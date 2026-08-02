"""
LibreOffice Calc macro — Import event orders via BTS automation API.

Reads the "EventOrders" sheet (configurable) and posts the rows to the
`event.import-orders` automation task. Dry-run is enabled by default.
"""

from __future__ import annotations

import inspect
import os
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
    from scripts_desktop.libreoffice.config_loader import load_config_map
    from scripts_desktop.libreoffice.notify import notify
    from automation_client import (
        AutomationClient,
        AutomationConfig,
        AutomationError,
        capture_logs,
        ensure_env_loaded,
        normalize_cell_value,
        resolve_flag,
    )
except ImportError:
    module_dir = _module_dir()
    section_dir = module_dir.parent  # scripts_desktop/libreoffice/
    desktop_dir = section_dir.parent  # scripts_desktop/
    repo_root = desktop_dir.parent  # repo root
    for candidate in (module_dir, section_dir, repo_root):
        path_str = str(candidate)
        if path_str not in sys.path:
            sys.path.append(path_str)
    from config_loader import load_config_map  # type: ignore
    from notify import notify  # type: ignore
    from automation_client import (  # type: ignore
        AutomationClient,
        AutomationConfig,
        AutomationError,
        capture_logs,
        ensure_env_loaded,
        normalize_cell_value,
        resolve_flag,
    )

ensure_env_loaded()

INTEGRATION = 'libreoffice-calc'
DEFAULT_SCOPES = ('automation:jobs:write', 'automation:jobs:run', 'automation:events:write')
SHEET_NAME = os.environ.get('BTS_EVENT_ORDERS_SHEET', 'EventOrders')
CONFIG_SHEET_NAME = os.environ.get('BTS_CONFIG_SHEET', 'BTS_Config')


def _current_user_email() -> str:
    try:
        ctx = XSCRIPTCONTEXT.getComponentContext()
        supplier = ctx.getValueByName('/singletons/com.sun.star.util.thePathSettings')
        return supplier.User or 'libreoffice'
    except Exception:
        return 'libreoffice'


def _sheet_by_name(doc, name: str):
    try:
        return doc.Sheets.getByName(name)
    except Exception:
        return None


def _sheet_data(sheet) -> List[List[Any]]:
    cursor = sheet.createCursor()
    cursor.gotoEndOfUsedArea(True)
    rng = sheet.getCellRangeByPosition(
        0, 0,
        cursor.RangeAddress.EndColumn,
        cursor.RangeAddress.EndRow
    )
    return [list(row) for row in rng.getDataArray()]


def _to_int(value: Any, default):
    if value is None or value == '':
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if value != value:  # NaN
            return default
        return int(round(value))
    try:
        text = str(value).strip().replace(',', '.')
        if not text:
            return default
        parsed = float(text)
        if parsed != parsed:  # NaN
            return default
        return int(round(parsed))
    except Exception:
        return default


def _collect_orders(sheet) -> List[Dict[str, Any]]:
    data = _sheet_data(sheet)
    if len(data) <= 1:
        return []

    headers = [normalize_cell_value(h).lower() for h in data[0]]
    index = {name: idx for idx, name in enumerate(headers) if name}

    def get(row, key, default=''):
        idx = index.get(key.lower())
        if idx is None:
            return default
        return row[idx]

    orders: Dict[str, Dict[str, Any]] = {}

    for row in data[1:]:
        payer_email = normalize_cell_value(get(row, 'payeremail'))
        event_slug = normalize_cell_value(get(row, 'eventslug'))
        event_id = normalize_cell_value(get(row, 'eventid'))
        zone_key = normalize_cell_value(get(row, 'zonekey'))
        seat_id = normalize_cell_value(get(row, 'seatid'))

        if not payer_email or (not event_slug and not event_id):
            continue
        if not zone_key and not seat_id:
            continue

        order_id = normalize_cell_value(get(row, 'orderid'))
        group_key = normalize_cell_value(get(row, 'groupkey')) or order_id

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
                'payerFirstName': normalize_cell_value(get(row, 'payerfirstname')),
                'payerLastName': normalize_cell_value(get(row, 'payerlastname')),
                'seasonCode': normalize_cell_value(get(row, 'seasoncode')),
                'venueSlug': normalize_cell_value(get(row, 'venueslug')),
                'status': normalize_cell_value(get(row, 'status')) or 'paid',
                'totalCents': _to_int(get(row, 'totalcents'), 0),
                'paymentSplit': _to_int(get(row, 'paymentsplit'), 1),
                'createdAt': normalize_cell_value(get(row, 'createdat')),
                'providerName': normalize_cell_value(get(row, 'providername')),
                'haOrderId': normalize_cell_value(get(row, 'haorderid')),
                'checkoutIntentId': normalize_cell_value(get(row, 'checkoutintentid')),
                'lastReturnCode': normalize_cell_value(get(row, 'lastreturncode')),
                'lastWebhookEvent': normalize_cell_value(get(row, 'lastwebhookevent')),
                'attestationSentAt': normalize_cell_value(get(row, 'attestationsentat')),
                'eventName': normalize_cell_value(get(row, 'eventname')),
                'eventStartsAt': normalize_cell_value(get(row, 'eventstartsat')),
                'eventNotes': normalize_cell_value(get(row, 'eventnotes')),
                'lines': []
            }

        order = orders[group_key]

        price_cents = get(row, 'pricecents')
        price_euro = get(row, 'priceeuro') or get(row, 'price')
        price_value = _to_int(price_cents, None)
        if price_value is None or price_value <= 0:
            euros = _to_int(price_euro, None)
            if euros is not None and euros > 0:
                price_value = int(round(euros * 100))
        if price_value is None or price_value < 0:
            price_value = 0

        quantity = max(1, _to_int(get(row, 'quantity'), 1))

        order['lines'].append({
            'seatId': seat_id,
            'zoneKey': zone_key,
            'tariffCode': (normalize_cell_value(get(row, 'tariffcode')) or normalize_cell_value(get(row, 'tariff')) or '').upper(),
            'priceCents': price_value,
            'quantity': quantity,
            'holderFirstName': normalize_cell_value(get(row, 'holderfirstname')),
            'holderLastName': normalize_cell_value(get(row, 'holderlastname'))
        })

    result: List[Dict[str, Any]] = []
    for order in orders.values():
        if not order['lines']:
            continue
        if not (order['eventSlug'] or order['eventId']):
            continue
        if order['totalCents'] <= 0:
            total = 0
            for line in order['lines']:
                total += int(line.get('priceCents', 0)) * int(line.get('quantity', 1))
            order['totalCents'] = total
        result.append(order)
    return result


def import_event_orders_from_calc() -> None:
    with capture_logs('import-event-orders'):
        doc = XSCRIPTCONTEXT.getDocument()
        sheet = _sheet_by_name(doc, SHEET_NAME) or doc.CurrentController.ActiveSheet
        sheet_name = getattr(sheet, 'Name', SHEET_NAME)

        config_map = load_config_map(doc, CONFIG_SHEET_NAME)
        config = AutomationConfig.from_env(
            default_issuer='libreoffice', default_scopes=DEFAULT_SCOPES
        ).apply_overrides(config_map, sheet_name=sheet_name)
        dry_run = resolve_flag(
            'BTS_EVENT_IMPORT_DRY_RUN', config_map, sheet_name=sheet_name,
            aliases=('event.import.dryrun', 'event_import_dry_run', 'bts_event_import_dry_run'),
            default=True,
        )
        force_flag = resolve_flag(
            'BTS_EVENT_IMPORT_FORCE', config_map, sheet_name=sheet_name,
            aliases=('event.import.force', 'event_import_force', 'bts_event_import_force'),
            default=False,
        )
        send_email_flag = resolve_flag(
            'BTS_EVENT_IMPORT_SEND_EMAIL', config_map, sheet_name=sheet_name,
            aliases=('event.import.sendemail', 'event_import_send_email', 'bts_event_import_send_email'),
            default=False,
        )

        orders = _collect_orders(sheet)
        if not orders:
            notify('Aucune commande valide détectée (payerEmail + eventSlug/eventId + zoneKey/seatId).', document=doc)
            return

        payload = {
            'dryRun': dry_run,
            'force': force_flag,
            'sendEmail': send_email_flag,
            'orders': orders,
            'metadata': {
                'source': 'libreoffice',
                'sheetName': sheet_name,
                'workbookUrl': getattr(doc, 'URL', ''),
                'configSheet': CONFIG_SHEET_NAME
            }
        }

        client = AutomationClient(config, integration=INTEGRATION, requested_by=_current_user_email)
        try:
            response = client.post_job('scripts/event.import-orders/jobs', payload)
        except AutomationError as err:
            notify(f'Import event orders failed: {err}', document=doc)
            return

        job = response.get('job', {})
        summary = job.get('summary') or {}
        message = f"Job {job.get('id', 'unknown')} enregistré ({job.get('status', 'queued')})."
        if summary:
            message += f"\nCréer: {summary.get('created', '?')} · MAJ: {summary.get('updated', '?')} · Ignorés: {summary.get('skipped', '?')}."
        notify(message, document=doc)


g_exportedScripts = (import_event_orders_from_calc,)
