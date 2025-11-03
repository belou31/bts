"""
LibreOffice Calc macro — Import tariff price catalog via BTS automation API.
"""

from __future__ import annotations

import inspect
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, List

import uno

try:
    from scripts_libreoffice.env_loader import ensure_loaded as _ensure_env_loaded
    from scripts_libreoffice.log_utils import capture_logs, current_log_path
    from scripts_libreoffice.config_loader import load_config_map, resolve_setting, lookup_config
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
    from config_loader import load_config_map, resolve_setting, lookup_config  # type: ignore

_ensure_env_loaded()

BTS_BASE_URL = os.environ.get('BTS_BASE_URL', 'http://127.0.0.1:8080')
AUTOMATION_SECRET = os.environ.get('AUTOMATION_JWT_SECRET', '')
AUTOMATION_ISS = os.environ.get('AUTOMATION_JWT_ISS', 'libreoffice')
AUTOMATION_AUD = os.environ.get('AUTOMATION_JWT_AUD', 'bts-automation')
AUTOMATION_SCOPES = os.environ.get(
    'AUTOMATION_JWT_SCOPES',
    'automation:jobs:write automation:jobs:run automation:events:write'
).split()

SHEET_NAME = os.environ.get('BTS_TARIFF_PRICES_SHEET', 'TariffPrices')
DRY_RUN_DEFAULT = os.environ.get('BTS_TARIFF_PRICES_DRY_RUN', 'true').lower() in {'1', 'true', 'yes', 'y'}
APPEND_DEFAULT = os.environ.get('BTS_TARIFF_PRICES_APPEND', 'false').lower() in {'1', 'true', 'yes', 'y'}
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


def _sheet_data(sheet) -> List[List[Any]]:
    cursor = sheet.createCursor()
    cursor.gotoEndOfUsedArea(True)
    rng = sheet.getCellRangeByPosition(
        0, 0,
        cursor.RangeAddress.EndColumn,
        cursor.RangeAddress.EndRow
    )
    return [list(row) for row in rng.getDataArray()]


def _normalize(value: Any) -> str:
    if value is None:
        return ''
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return f'{value}'
    return str(value).strip()


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


def _apply_config_overrides(doc, sheet_name: str) -> Dict[str, str]:
    config_map = load_config_map(doc, CONFIG_SHEET_NAME)

    global BTS_BASE_URL
    global AUTOMATION_SECRET
    global AUTOMATION_ISS
    global AUTOMATION_AUD
    global AUTOMATION_SCOPES
    global DRY_RUN_DEFAULT
    global APPEND_DEFAULT

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
        'BTS_TARIFF_PRICES_DRY_RUN',
        config_map,
        sheet_name=sheet_name,
        aliases=('tariff.prices.dryrun', 'tariff_prices_dry_run', 'bts_tariff_prices_dry_run'),
        default='true' if DRY_RUN_DEFAULT else 'false',
    )
    DRY_RUN_DEFAULT = _parse_bool(dry_raw, DRY_RUN_DEFAULT)

    append_raw = resolve_setting(
        'BTS_TARIFF_PRICES_APPEND',
        config_map,
        sheet_name=sheet_name,
        aliases=('tariff.prices.append', 'tariff_prices_append', 'bts_tariff_prices_append'),
        default='true' if APPEND_DEFAULT else 'false',
    )
    APPEND_DEFAULT = _parse_bool(append_raw, APPEND_DEFAULT)

    return config_map


def _collect_entries(sheet, config_map: Dict[str, str] | None = None, sheet_name: str = ''):
    data = _sheet_data(sheet)
    if len(data) <= 1:
        return [], '', ''

    headers = [_normalize(h).lower() for h in data[0]]
    index = {name: idx for idx, name in enumerate(headers) if name}

    config_source = config_map or {}
    catalog_default = lookup_config(config_source, 'tariff.prices.slug', sheet_name)
    venue_default = lookup_config(config_source, 'tariff.prices.venue', sheet_name)

    def get(row, key):
        idx = index.get(key.lower())
        if idx is None or idx >= len(row):
            return ''
        return row[idx]

    entries = []
    for row in data[1:]:
        catalog_slug = _normalize(get(row, 'catalogslug') or get(row, 'catalog')).lower()
        if not catalog_slug and catalog_default:
            catalog_slug = catalog_default.lower()
        zone_key = _normalize(get(row, 'zonekey') or get(row, 'zone')).upper()
        tariff_code = _normalize(get(row, 'tariffcode') or get(row, 'tariff') or get(row, 'code')).upper()
        if not catalog_slug or not zone_key or not tariff_code:
            continue

        entry = {
            'catalogSlug': catalog_slug,
            'venueSlug': (_normalize(get(row, 'venueslug')) or venue_default).strip() or None,
            'zoneKey': zone_key,
            'tariffCode': tariff_code,
            'priceCents': _normalize(get(row, 'pricecents')),
            'priceEuro': _normalize(get(row, 'priceeuro') or get(row, 'price')),
            'currency': _normalize(get(row, 'currency')) or 'EUR'
        }
        entries.append(entry)

    return entries, catalog_default.lower() if catalog_default else '', venue_default


def _b64url(data: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _sign(message: bytes) -> bytes:
    import hmac
    import hashlib
    return hmac.new(AUTOMATION_SECRET.encode('utf-8'), message, hashlib.sha256).digest()


def _create_jwt() -> str:
    if not AUTOMATION_SECRET:
        raise RuntimeError('AUTOMATION_JWT_SECRET manquant.')
    import time
    now = int(time.time())
    header = {'alg': 'HS256', 'typ': 'JWT'}
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
    signature = _sign(signing_input.encode('utf-8'))
    return f'{signing_input}.{_b64url(signature)}'


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


def import_tariff_prices_from_calc():
    with capture_logs('import-tariff-prices'):
        doc = XSCRIPTCONTEXT.getDocument()
        sheet = _sheet_by_name(doc, SHEET_NAME) or doc.CurrentController.ActiveSheet
        sheet_name = getattr(sheet, 'Name', SHEET_NAME)
        config_map = _apply_config_overrides(doc, sheet_name)
        entries, default_catalog, default_venue = _collect_entries(sheet, config_map, sheet_name)
        if not entries:
            _notify('Aucune ligne valide (catalogSlug, zoneKey, tariffCode, prix) détectée.')
            return

        dry_run = DRY_RUN_DEFAULT
        append_flag = APPEND_DEFAULT

        payload = {
            'dryRun': dry_run,
            'append': append_flag,
            'entries': entries,
            'catalogSlug': default_catalog or None,
            'venueSlug': default_venue or None,
            'metadata': {
                'source': 'libreoffice',
                'sheetName': sheet_name,
                'configSheet': CONFIG_SHEET_NAME if config_map else None,
                'configDefaults': {
                    'catalogSlug': default_catalog or None,
                    'venueSlug': default_venue or None,
                    'dryRun': dry_run,
                    'append': append_flag
                }
            }
        }

        try:
            response = _automation_fetch('scripts/tariff.import-prices/jobs', payload)
        except Exception as err:
            _notify(f'Import tariff prices failed: {err}')
            return

        job = response.get('job', {})
        summary = job.get('summary', '')
        message = f"Job {job.get('id', 'unknown')} enregistré ({job.get('status', 'queued')})."
        if summary:
            message += f"\n{summary}"
        _notify(message)


g_exportedScripts = (import_tariff_prices_from_calc,)
