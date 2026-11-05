"""
LibreOffice Calc macro — Export tariff catalog via BTS automation API.

Round-trip companion to import_tariffs.py: fetches the tariff catalog as it
currently stands in the database and repopulates the TariffCatalog sheet
with it, so you can import a sheet edit then re-export to confirm the
database now reflects it.
"""

from __future__ import annotations

import inspect
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

try:
    from scripts_desktop.libreoffice.config_loader import load_config_map
    from scripts_desktop.libreoffice.notify import notify
    from automation_client import (
        AutomationClient,
        AutomationConfig,
        AutomationError,
        capture_logs,
        ensure_env_loaded,
    )
except ImportError:
    def _module_dir() -> Path:
        try:
            return Path(__file__).resolve().parent
        except NameError:
            frame = inspect.currentframe()
            if frame is None:
                raise
            return Path(inspect.getfile(frame)).resolve().parent

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
    )

ensure_env_loaded()

INTEGRATION = 'libreoffice-calc'
DEFAULT_SCOPES = ('automation:jobs:write', 'automation:jobs:run')
SHEET_NAME = os.environ.get('BTS_TARIFF_CATALOG_SHEET', 'TariffCatalog')
CONFIG_SHEET_NAME = os.environ.get('BTS_CONFIG_SHEET', 'BTS_Config')

HEADERS = ['code', 'label', 'requiresField', 'fieldLabel', 'requiresInfo', 'active', 'sortOrder', 'channels']


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


def _write_entries(sheet, entries: List[Dict[str, Any]]) -> None:
    cursor = sheet.createCursor()
    cursor.gotoEndOfUsedArea(True)
    last_col = max(cursor.RangeAddress.EndColumn, len(HEADERS) - 1)
    last_row = max(cursor.RangeAddress.EndRow, len(entries))
    sheet.getCellRangeByPosition(0, 0, last_col, last_row).clearContents(
        # value | date-time | string | annotation | formula | hard-attr | style | editattr | formatted
        # Clear everything a stray value/format could leave behind.
        1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256
    )

    for col, header in enumerate(HEADERS):
        sheet.getCellByPosition(col, 0).setString(header)

    for row, entry in enumerate(entries, start=1):
        for col, header in enumerate(HEADERS):
            cell = sheet.getCellByPosition(col, row)
            value = entry.get(header, '')
            if header == 'active':
                cell.setString('true' if value else 'false')
            elif header == 'sortOrder':
                cell.setValue(float(value) if value not in (None, '') else 100)
            else:
                cell.setString('' if value is None else str(value))


def export_tariffs_from_calc() -> None:
    with capture_logs('export-tariffs'):
        doc = XSCRIPTCONTEXT.getDocument()
        sheet = _sheet_by_name(doc, SHEET_NAME) or doc.CurrentController.ActiveSheet
        sheet_name = getattr(sheet, 'Name', SHEET_NAME)

        config_map = load_config_map(doc, CONFIG_SHEET_NAME)
        config = AutomationConfig.from_env(
            default_issuer='libreoffice', default_scopes=DEFAULT_SCOPES
        ).apply_overrides(config_map, sheet_name=sheet_name)

        payload = {
            'runMode': 'sync',
            'metadata': {
                'source': 'libreoffice',
                'sheetName': sheet_name,
            }
        }

        client = AutomationClient(config, integration=INTEGRATION, requested_by=_current_user_email)
        try:
            response = client.post_job('scripts/tariff.export-catalog/jobs', payload)
        except AutomationError as err:
            notify(f'Export tariffs failed: {err}', document=doc)
            return

        job = response.get('job', {})
        if job.get('status') != 'succeeded':
            error = job.get('error') or {}
            notify(f"Export failed: {error.get('message', job.get('status', 'unknown error'))}", document=doc)
            return

        entries = ((job.get('result') or {}).get('payload') or {}).get('entries', [])
        _write_entries(sheet, entries)
        notify(f'Export : {len(entries)} tarif(s) rapatriés dans la feuille "{sheet_name}".', document=doc)


g_exportedScripts = (export_tariffs_from_calc,)
