"""
LibreOffice Calc macro — Send renewal invitations via BTS automation API.

Copy this file into your LibreOffice Scripts/python folder, then restart Calc.
You can bind it to the custom "BTS" menu or run it via Tools → Macros → Run Macro.
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

# === Configuration ==========================================================
INTEGRATION = 'libreoffice-calc'
DEFAULT_SCOPES = ('automation:jobs:write', 'automation:jobs:run')
DEFAULT_SUBJECT = 'Renouvellement d’abonnement'
DEFAULT_SEASON_CODE = os.environ.get('SEASON_CODE', '2025-2026')
DEFAULT_DEADLINE = os.environ.get('RENEW_DEADLINE', '')
DEFAULT_PROVIDER_LABEL = os.environ.get('PAYMENT_PROVIDER_NAME', 'HelloAsso')
SHEET_NAME = 'Invitations'
CONFIG_SHEET_NAME = os.environ.get('BTS_CONFIG_SHEET', 'BTS_Config')


# === Helpers ================================================================

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


def _infer_header_map(headers: List[Any]) -> Dict[str, int]:
    mapping: Dict[str, int] = {}
    for idx, value in enumerate(headers):
        key = normalize_cell_value(value).lower()
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
        email = normalize_cell_value(row[idx['email']])
        renew_url = normalize_cell_value(row[idx['renewurl']])
        if not email or not renew_url:
            continue
        invitees.append({
            'email': email,
            'renewUrl': renew_url,
            'firstName': normalize_cell_value(row[idx['firstname']]) if 'firstname' in idx else '',
            'lastName': normalize_cell_value(row[idx['lastname']]) if 'lastname' in idx else '',
            'seats': normalize_cell_value(row[idx['seats']]) if 'seats' in idx else ''
        })
    return invitees


def _job_request(invitees: List[Dict[str, Any]], sheet_name: str, dry_run: bool) -> Dict[str, Any]:
    return {
        'dryRun': dry_run,
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


# === Entrypoint =============================================================

def send_renew_invites_from_calc() -> None:
    with capture_logs('send-renew-invites'):
        doc = XSCRIPTCONTEXT.getDocument()
        sheet = _sheet_by_name(doc, SHEET_NAME) or doc.CurrentController.ActiveSheet
        sheet_name = getattr(sheet, 'Name', SHEET_NAME)

        config_map = load_config_map(doc, CONFIG_SHEET_NAME)
        config = AutomationConfig.from_env(
            default_issuer='libreoffice', default_scopes=DEFAULT_SCOPES
        ).apply_overrides(config_map, sheet_name=sheet_name)
        dry_run = resolve_flag(
            'BTS_RENEW_INVITES_DRY_RUN', config_map, sheet_name=sheet_name,
            aliases=('renew.dryrun', 'renew_dry_run', 'bts_renew_invites_dry_run'),
            default=False,
        )

        data = _sheet_data(sheet)
        if len(data) <= 1:
            notify('No data rows found.', document=doc)
            return

        try:
            invitees = _invite_rows(data)
        except Exception as err:
            notify(f'Invalid sheet data: {err}', document=doc)
            return

        if not invitees:
            notify('No valid invitations (email + renewUrl) found.', document=doc)
            return

        client = AutomationClient(config, integration=INTEGRATION, requested_by=_current_user_email)
        try:
            response = client.post_job(
                'scripts/season.send-renew-invites/jobs',
                _job_request(invitees, sheet_name, dry_run),
            )
            job = response.get('job', {})
            notify(f"Job {job.get('id', 'unknown')} queued ({job.get('status', 'queued')}).", document=doc)
        except AutomationError as err:
            notify(f'Automation call failed: {err}', document=doc)


g_exportedScripts = (send_renew_invites_from_calc,)
