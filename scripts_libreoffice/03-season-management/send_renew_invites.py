"""
LibreOffice Calc macro — Send renewal invitations via BTS automation API.

Copy this file into your LibreOffice Scripts/python folder, then restart Calc.
You can bind it to the custom “BTS” menu or run it via Tools → Macros → Run Macro.
"""

import base64
import hashlib
import hmac
import inspect
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List

import uno


def _module_dir() -> Path:
    try:
        return Path(__file__).resolve().parent
    except NameError:
        frame = inspect.currentframe()
        if frame is None:
            raise
        return Path(inspect.getfile(frame)).resolve().parent


try:
    from scripts_libreoffice.env_loader import ensure_loaded as _ensure_env_loaded
    from scripts_libreoffice.log_utils import capture_logs, current_log_path
    from scripts_libreoffice.config_loader import load_config_map, resolve_setting
except ImportError:
    module_dir = _module_dir()
    parent_dir = module_dir.parent
    for candidate in (module_dir, parent_dir):
        candidate_str = str(candidate)
        if candidate_str not in sys.path:
            sys.path.append(candidate_str)
    from env_loader import ensure_loaded as _ensure_env_loaded  # type: ignore
    from log_utils import capture_logs, current_log_path  # type: ignore
    from config_loader import load_config_map, resolve_setting  # type: ignore

_ensure_env_loaded()

# === Configuration ==========================================================
BTS_BASE_URL = os.environ.get('BTS_BASE_URL', 'http://127.0.0.1:8080')
AUTOMATION_SECRET = os.environ.get('AUTOMATION_JWT_SECRET', '')
AUTOMATION_ISS = os.environ.get('AUTOMATION_JWT_ISS', 'libreoffice')
AUTOMATION_AUD = os.environ.get('AUTOMATION_JWT_AUD', 'bts-automation')
AUTOMATION_SCOPES = os.environ.get(
    'AUTOMATION_JWT_SCOPES',
    'automation:jobs:write automation:jobs:run'
).split()
DEFAULT_SUBJECT = 'Renouvellement d’abonnement'
DEFAULT_SEASON_CODE = os.environ.get('SEASON_CODE', '2025-2026')
DEFAULT_DEADLINE = os.environ.get('RENEW_DEADLINE', '')
DEFAULT_PROVIDER_LABEL = os.environ.get('PAYMENT_PROVIDER_NAME', 'HelloAsso')
DRY_RUN_DEFAULT = True
SHEET_NAME = 'Invitations'
CONFIG_SHEET_NAME = os.environ.get('BTS_CONFIG_SHEET', 'BTS_Config')


# === Helpers ================================================================

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _current_user_email() -> str:
    try:
        ctx = XSCRIPTCONTEXT.getComponentContext()
        supplier = ctx.getValueByName('/singletons/com.sun.star.util.thePathSettings')
        user = supplier.User
        return user or 'libreoffice'
    except Exception:
        return 'libreoffice'


def _create_jwt() -> str:
    if not AUTOMATION_SECRET:
        raise RuntimeError('AUTOMATION_JWT_SECRET is missing for LibreOffice macro.')
    header = {'alg': 'HS256', 'typ': 'JWT'}
    now = int(time.time())
    payload = {
        'iss': AUTOMATION_ISS,
        'aud': AUTOMATION_AUD,
        'iat': now,
        'exp': now + 300,
        'scopes': AUTOMATION_SCOPES,
        'integration': 'libreoffice-calc',
        'requestedBy': _current_user_email()
    }
    signing_input = '.'.join([
        _b64url(json.dumps(header, separators=(',', ':')).encode('utf-8')),
        _b64url(json.dumps(payload, separators=(',', ':')).encode('utf-8'))
    ])
    signature = hmac.new(
        AUTOMATION_SECRET.encode('utf-8'),
        signing_input.encode('utf-8'),
        hashlib.sha256
    ).digest()
    return f'{signing_input}.{_b64url(signature)}'


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


def _sheet_by_name(doc, name: str):
    try:
        return doc.Sheets.getByName(name)
    except Exception:
        return None


def _apply_config_overrides(doc, sheet_name: str):
    config_map = load_config_map(doc, CONFIG_SHEET_NAME)
    if not config_map:
        return

    global BTS_BASE_URL
    global AUTOMATION_SECRET
    global AUTOMATION_ISS
    global AUTOMATION_AUD
    global AUTOMATION_SCOPES

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


def _sheet_data(sheet) -> List[List[Any]]:
    cursor = sheet.createCursor()
    cursor.gotoEndOfUsedArea(True)
    rng = sheet.getCellRangeByPosition(
        0, 0,
        cursor.RangeAddress.EndColumn,
        cursor.RangeAddress.EndRow
    )
    return [list(row) for row in rng.getDataArray()]


def _infer_header_map(headers: List[Any]) -> Dict[str, int]:
    mapping: Dict[str, int] = {}
    for idx, value in enumerate(headers):
        key = str(value).strip().lower()
        if key:
            mapping[key] = idx
    return mapping


def _invite_rows(rows: List[List[Any]]) -> List[Dict[str, Any]]:
    if not rows:
        return []
    headers = rows[0]
    data_rows = rows[1:]
    idx = _infer_header_map(headers)
    for req in ('email', 'renewurl'):
        if req not in idx:
            raise ValueError(f"Missing required column '{req}' in sheet header.")

    invitees: List[Dict[str, Any]] = []
    for row in data_rows:
        email = str(row[idx['email']]).strip()
        renew_url = str(row[idx['renewurl']]).strip()
        if not email or not renew_url:
            continue
        invitees.append({
            'email': email,
            'renewUrl': renew_url,
            'firstName': str(row[idx.get('firstname', -1)]).strip() if 'firstname' in idx else '',
            'lastName': str(row[idx.get('lastname', -1)]).strip() if 'lastname' in idx else '',
            'seats': str(row[idx.get('seats', -1)]).strip() if 'seats' in idx else ''
        })
    return invitees


def _job_request(invitees: List[Dict[str, Any]], sheet_name: str) -> Dict[str, Any]:
    return {
        'dryRun': DRY_RUN_DEFAULT,
        'params': {
            'csv': 'libreoffice-sheet',
            'template': 'renew-invite',
            'subject': DEFAULT_SUBJECT,
            'seasonCode': DEFAULT_SEASON_CODE,
            'deadline': DEFAULT_DEADLINE,
            'providerLabel': DEFAULT_PROVIDER_LABEL,
            'invitees': invitees
        },
        'metadata': {
            'source': 'libreoffice',
            'sheetName': sheet_name,
            'configSheet': CONFIG_SHEET_NAME
        }
    }


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


# === Entrypoint =============================================================

def send_renew_invites_from_calc():
    with capture_logs('send-renew-invites'):
        doc = XSCRIPTCONTEXT.getDocument()
        sheet = _sheet_by_name(doc, SHEET_NAME) or doc.CurrentController.ActiveSheet
        sheet_name = getattr(sheet, 'Name', SHEET_NAME)
        _apply_config_overrides(doc, sheet_name)
        data = _sheet_data(sheet)
        if len(data) <= 1:
            _notify('No data rows found.')
            return

        try:
            invitees = _invite_rows(data)
        except Exception as err:
            _notify(f'Invalid sheet data: {err}')
            return

        if not invitees:
            _notify('No valid invitations (email + renewUrl) found.')
            return

        try:
            result = _automation_fetch('scripts/season.send-renew-invites/jobs', _job_request(invitees, sheet_name))
            job = result.get('job', {})
            _notify(f"Job {job.get('id', 'unknown')} queued ({job.get('status', 'queued')}).")
        except Exception as err:
            _notify(f'Automation call failed: {err}')


g_exportedScripts = (send_renew_invites_from_calc,)
