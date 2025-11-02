"""
LibreOffice Calc macro — Import event orders via BTS automation API.

Reads the "EventOrders" sheet (configurable) and posts the rows to the
`event.import-orders` automation task. Dry-run is enabled by default.
"""

from __future__ import annotations

import inspect
import json
import os
import sys
import urllib.error
import urllib.request
import time
from datetime import datetime, date
from typing import Any, Dict, List

import uno

try:
    from scripts_libreoffice.env_loader import ensure_loaded as _ensure_env_loaded
    from scripts_libreoffice.log_utils import capture_logs, current_log_path
    from scripts_libreoffice.config_loader import load_config_map, resolve_setting
except ImportError:
    def _module_dir():
        try:
            from pathlib import Path
            return Path(__file__).resolve().parent
        except NameError:
            frame = inspect.currentframe()
            if frame is None:
                raise
            from pathlib import Path
            return Path(inspect.getfile(frame)).resolve().parent

    module_dir = _module_dir()
    parent_dir = module_dir.parent
    for candidate in (module_dir, parent_dir):
        path_str = str(candidate)
        if path_str not in sys.path:
            sys.path.append(path_str)
    from env_loader import ensure_loaded as _ensure_env_loaded  # type: ignore
    from log_utils import capture_logs, current_log_path  # type: ignore
    from config_loader import load_config_map, resolve_setting  # type: ignore

_ensure_env_loaded()

BTS_BASE_URL = os.environ.get('BTS_BASE_URL', 'http://127.0.0.1:8080')
AUTOMATION_SECRET = os.environ.get('AUTOMATION_JWT_SECRET', '')
AUTOMATION_ISS = os.environ.get('AUTOMATION_JWT_ISS', 'libreoffice')
AUTOMATION_AUD = os.environ.get('AUTOMATION_JWT_AUD', 'bts-automation')
AUTOMATION_SCOPES = os.environ.get(
    'AUTOMATION_JWT_SCOPES',
    'automation:jobs:write automation:jobs:run automation:events:write'
).split()

SHEET_NAME = os.environ.get('BTS_EVENT_ORDERS_SHEET', 'EventOrders')
DRY_RUN_DEFAULT = os.environ.get('BTS_EVENT_IMPORT_DRY_RUN', 'true').lower() in {'1', 'true', 'yes', 'y'}
FORCE_DEFAULT = os.environ.get('BTS_EVENT_IMPORT_FORCE', 'false').lower() in {'1', 'true', 'yes', 'y'}
SEND_EMAIL_DEFAULT = os.environ.get('BTS_EVENT_IMPORT_SEND_EMAIL', 'false').lower() in {'1', 'true', 'yes', 'y'}
CONFIG_SHEET_NAME = os.environ.get('BTS_CONFIG_SHEET', 'BTS_Config')


def _notify(message: str):
    log_path = current_log_path()
    if log_path:
        message = f"{message}\n\nLog file: {log_path}"

    try:
        desktop = XSCRIPTCONTEXT.getDesktop()
        frame = desktop.getCurrentFrame()
        window = frame.getContainerWindow()
        toolkit = window.getToolkit()
        box_type = uno.getConstantByName('com.sun.star.awt.MessageBoxType.INFOBOX')
        buttons = uno.getConstantByName('com.sun.star.awt.MessageBoxButtons.BUTTONS_OK')
        msgbox = toolkit.createMessageBox(window, box_type, buttons, 'BTS Automation', str(message))
        msgbox.execute()
    except Exception:
        print(f'[BTS Automation] {message}')


def _sheet_by_name(doc, name: str):
    try:
        return doc.Sheets.getByName(name)
    except Exception:
        return None


def _parse_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    text = value.strip().lower()
    if not text:
        return default
    if text in {'1', 'true', 'yes', 'y', 'on'}:
        return True
    if text in {'0', 'false', 'no', 'n', 'off'}:
        return False
    return default


def _apply_config_overrides(doc, sheet_name: str):
    config_map = load_config_map(doc, CONFIG_SHEET_NAME)
    if not config_map:
        return

    global BTS_BASE_URL
    global AUTOMATION_SECRET
    global AUTOMATION_ISS
    global AUTOMATION_AUD
    global AUTOMATION_SCOPES
    global DRY_RUN_DEFAULT
    global FORCE_DEFAULT
    global SEND_EMAIL_DEFAULT

    base_url = resolve_setting(
        'BTS_BASE_URL',
        config_map,
        sheet_name=sheet_name,
        aliases=('base.url', 'base_url', 'bts_base_url'),
        default=BTS_BASE_URL,
    )
    if base_url:
        BTS_BASE_URL = base_url

    secret = resolve_setting(
        'AUTOMATION_JWT_SECRET',
        config_map,
        sheet_name=sheet_name,
        aliases=('automation.secret', 'automation.jwt.secret', 'automation_jwt_secret'),
        default=AUTOMATION_SECRET,
    )
    if secret:
        AUTOMATION_SECRET = secret

    issuer = resolve_setting(
        'AUTOMATION_JWT_ISS',
        config_map,
        sheet_name=sheet_name,
        aliases=('jwt.iss', 'automation.jwt.iss', 'automation_jwt_iss'),
        default=AUTOMATION_ISS,
    )
    if issuer:
        AUTOMATION_ISS = issuer

    audience = resolve_setting(
        'AUTOMATION_JWT_AUD',
        config_map,
        sheet_name=sheet_name,
        aliases=('jwt.aud', 'automation.jwt.aud', 'automation_jwt_aud'),
        default=AUTOMATION_AUD,
    )
    if audience:
        AUTOMATION_AUD = audience

    scopes = resolve_setting(
        'AUTOMATION_JWT_SCOPES',
        config_map,
        sheet_name=sheet_name,
        aliases=('jwt.scopes', 'automation.jwt.scopes', 'automation_jwt_scopes'),
        default=' '.join(AUTOMATION_SCOPES),
    )
    if scopes:
        AUTOMATION_SCOPES = scopes.split()

    dry_raw = resolve_setting(
        'BTS_EVENT_IMPORT_DRY_RUN',
        config_map,
        sheet_name=sheet_name,
        aliases=('event.import.dryrun', 'event_import_dry_run', 'bts_event_import_dry_run'),
        default='true' if DRY_RUN_DEFAULT else 'false',
    )
    DRY_RUN_DEFAULT = _parse_bool(dry_raw, DRY_RUN_DEFAULT)

    force_raw = resolve_setting(
        'BTS_EVENT_IMPORT_FORCE',
        config_map,
        sheet_name=sheet_name,
        aliases=('event.import.force', 'event_import_force', 'bts_event_import_force'),
        default='true' if FORCE_DEFAULT else 'false',
    )
    FORCE_DEFAULT = _parse_bool(force_raw, FORCE_DEFAULT)

    send_email_raw = resolve_setting(
        'BTS_EVENT_IMPORT_SEND_EMAIL',
        config_map,
        sheet_name=sheet_name,
        aliases=('event.import.sendemail', 'event_import_send_email', 'bts_event_import_send_email'),
        default='true' if SEND_EMAIL_DEFAULT else 'false',
    )
    SEND_EMAIL_DEFAULT = _parse_bool(send_email_raw, SEND_EMAIL_DEFAULT)


def _sheet_data(sheet) -> List[List[Any]]:
    cursor = sheet.createCursor()
    cursor.gotoEndOfUsedArea(True)
    rng = sheet.getCellRangeByPosition(
        0, 0,
        cursor.RangeAddress.EndColumn,
        cursor.RangeAddress.EndRow
    )
    return [list(row) for row in rng.getDataArray()]


def _normalize_string(value: Any) -> str:
    if value is None:
        return ''
    if isinstance(value, float):
        # Treat float that represents an integer as int; otherwise keep string
        if value.is_integer():
            return str(int(value))
        return f"{value}".strip()
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value).strip()


def _to_int(value: Any, default: int = 0) -> int:
    if value is None or value == '':
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if value != value:
            return default
        return int(round(value))
    try:
        text = str(value).strip().replace(',', '.')
        if not text:
            return default
        parsed = float(text)
        if parsed != parsed:
            return default
        return int(round(parsed))
    except Exception:
        return default


def _collect_orders(sheet) -> List[Dict[str, Any]]:
    data = _sheet_data(sheet)
    if len(data) <= 1:
        return []

    headers = [str(h).strip().lower() for h in data[0]]
    index = {name: idx for idx, name in enumerate(headers) if name}

    def get(row, key, default=''):
        idx = index.get(key.lower())
        if idx is None:
            return default
        return row[idx]

    orders: Dict[str, Dict[str, Any]] = {}

    for row in data[1:]:
        payer_email = _normalize_string(get(row, 'payeremail'))
        event_slug = _normalize_string(get(row, 'eventslug'))
        event_id = _normalize_string(get(row, 'eventid'))
        zone_key = _normalize_string(get(row, 'zonekey'))
        seat_id = _normalize_string(get(row, 'seatid'))

        if not payer_email or (not event_slug and not event_id):
            continue
        if not zone_key and not seat_id:
            continue

        order_id = _normalize_string(get(row, 'orderid'))
        group_key = _normalize_string(get(row, 'groupkey')) or order_id

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
                'payerFirstName': _normalize_string(get(row, 'payerfirstname')),
                'payerLastName': _normalize_string(get(row, 'payerlastname')),
                'seasonCode': _normalize_string(get(row, 'seasoncode')),
                'venueSlug': _normalize_string(get(row, 'venueslug')),
                'status': _normalize_string(get(row, 'status')) or 'paid',
                'totalCents': _to_int(get(row, 'totalcents'), 0),
                'paymentSplit': _to_int(get(row, 'paymentsplit'), 1),
                'createdAt': _normalize_string(get(row, 'createdat')),
                'providerName': _normalize_string(get(row, 'providername')),
                'haOrderId': _normalize_string(get(row, 'haorderid')),
                'checkoutIntentId': _normalize_string(get(row, 'checkoutintentid')),
                'lastReturnCode': _normalize_string(get(row, 'lastreturncode')),
                'lastWebhookEvent': _normalize_string(get(row, 'lastwebhookevent')),
                'attestationSentAt': _normalize_string(get(row, 'attestationsentat')),
                'eventName': _normalize_string(get(row, 'eventname')),
                'eventStartsAt': _normalize_string(get(row, 'eventstartsat')),
                'eventNotes': _normalize_string(get(row, 'eventnotes')),
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
            'tariffCode': (_normalize_string(get(row, 'tariffcode')) or _normalize_string(get(row, 'tariff')) or '').upper(),
            'priceCents': price_value,
            'quantity': quantity,
            'holderFirstName': _normalize_string(get(row, 'holderfirstname')),
            'holderLastName': _normalize_string(get(row, 'holderlastname'))
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


def _create_jwt() -> str:
    if not AUTOMATION_SECRET:
        raise RuntimeError('AUTOMATION_JWT_SECRET is missing for LibreOffice macro.')
    header = {'alg': 'HS256', 'typ': 'JWT'}
    now = int(time.time())
    payload = {
        'iss': AUTOMATION_ISS,
        'aud': AUTOMATION_AUD,
        'iat': now,
        'nbf': max(0, now - 30),
        'exp': now + 600,
        'scopes': AUTOMATION_SCOPES,
        'integration': 'libreoffice-calc',
        'requestedBy': _current_user_email()
    }
    signing_input = '.'.join([
        _b64url(json.dumps(header, separators=(',', ':')).encode('utf-8')),
        _b64url(json.dumps(payload, separators=(',', ':')).encode('utf-8'))
    ])
    signature = _hmac256(signing_input.encode('utf-8'))
    return f'{signing_input}.{_b64url(signature)}'


def _b64url(data: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _hmac256(message: bytes) -> bytes:
    import hmac
    import hashlib
    return hmac.new(AUTOMATION_SECRET.encode('utf-8'), message, hashlib.sha256).digest()


def _current_user_email() -> str:
    try:
        ctx = XSCRIPTCONTEXT.getComponentContext()
        supplier = ctx.getValueByName('/singletons/com.sun.star.util.thePathSettings')
        user = supplier.User
        return user or 'libreoffice'
    except Exception:
        return 'libreoffice'


def _automation_fetch(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token = _create_jwt()
    url = f"{BTS_BASE_URL.rstrip('/')}/api/automation/{path.lstrip('/')}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode('utf-8')
            return json.loads(body)
    except urllib.error.HTTPError as err:
        detail = err.read().decode('utf-8')
        raise RuntimeError(f'HTTP {err.code}: {detail}') from err


def import_event_orders_from_calc():
    with capture_logs('import-event-orders'):
        doc = XSCRIPTCONTEXT.getDocument()
        sheet = _sheet_by_name(doc, SHEET_NAME) or doc.CurrentController.ActiveSheet
        sheet_name = getattr(sheet, 'Name', SHEET_NAME)
        _apply_config_overrides(doc, sheet_name)
        orders = _collect_orders(sheet)
        if not orders:
            _notify('Aucune commande valide détectée (payerEmail + eventSlug/eventId + zoneKey/seatId).')
            return

        payload = {
            'dryRun': DRY_RUN_DEFAULT,
            'force': FORCE_DEFAULT,
            'sendEmail': SEND_EMAIL_DEFAULT,
            'orders': orders,
            'metadata': {
                'source': 'libreoffice',
                'sheetName': sheet_name,
                'workbookUrl': getattr(doc, 'URL', ''),
                'configSheet': CONFIG_SHEET_NAME
            }
        }

        try:
            response = _automation_fetch('scripts/event.import-orders/jobs', payload)
        except Exception as err:
            _notify(f'Import event orders failed: {err}')
            return

        job = response.get('job', {})
        summary = job.get('summary') or {}
        message = f"Job {job.get('id', 'unknown')} enregistré ({job.get('status', 'queued')})."
        if summary:
            message += f"\nCréer: {summary.get('created', '?')} · MAJ: {summary.get('updated', '?')} · Ignorés: {summary.get('skipped', '?')}."
        _notify(message)


g_exportedScripts = (import_event_orders_from_calc,)
