"""
LibreOffice Calc macro — Import tariff catalog via BTS automation API.
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
        parse_bool,
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
        parse_bool,
        resolve_flag,
    )

ensure_env_loaded()

INTEGRATION = 'libreoffice-calc'
DEFAULT_SCOPES = ('automation:jobs:write', 'automation:jobs:run')
SHEET_NAME = os.environ.get('BTS_TARIFF_CATALOG_SHEET', 'TariffCatalog')
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


def _collect_entries(sheet) -> List[Dict[str, Any]]:
    data = _sheet_data(sheet)
    if len(data) <= 1:
        return []

    headers = [normalize_cell_value(h).lower() for h in data[0]]
    index = {name: idx for idx, name in enumerate(headers) if name}

    def get(row, key):
        idx = index.get(key.lower())
        if idx is None or idx >= len(row):
            return ''
        return row[idx]

    entries = []
    for row in data[1:]:
        code = normalize_cell_value(get(row, 'code')).upper()
        label = normalize_cell_value(get(row, 'label'))
        if not code or not label:
            continue
        entry = {
            'code': code,
            'label': label,
            'requiresField': normalize_cell_value(get(row, 'requiresfield') or get(row, 'requires_field')),
            'fieldLabel': normalize_cell_value(get(row, 'fieldlabel') or get(row, 'field_label')),
            'requiresInfo': normalize_cell_value(get(row, 'requiresinfo') or get(row, 'requires_info')),
            'active': parse_bool(get(row, 'active') or get(row, 'enabled'), True),
            'sortOrder': normalize_cell_value(get(row, 'sortorder') or get(row, 'sort_order')),
            'channels': normalize_cell_value(get(row, 'channels') or get(row, 'channel') or get(row, 'scopes'))
        }
        entries.append(entry)
    return entries


def import_tariffs_from_calc() -> None:
    with capture_logs('import-tariffs'):
        doc = XSCRIPTCONTEXT.getDocument()
        sheet = _sheet_by_name(doc, SHEET_NAME) or doc.CurrentController.ActiveSheet
        sheet_name = getattr(sheet, 'Name', SHEET_NAME)

        config_map = load_config_map(doc, CONFIG_SHEET_NAME)
        config = AutomationConfig.from_env(
            default_issuer='libreoffice', default_scopes=DEFAULT_SCOPES
        ).apply_overrides(config_map, sheet_name=sheet_name)
        dry_run = resolve_flag(
            'BTS_TARIFF_CATALOG_DRY_RUN', config_map, sheet_name=sheet_name,
            aliases=('tariff.catalog.dryrun', 'tariff_catalog_dry_run', 'bts_tariff_catalog_dry_run'),
            default=False,
        )

        entries = _collect_entries(sheet)
        if not entries:
            notify('Aucune ligne valide (code + label) détectée.', document=doc)
            return

        payload = {
            'dryRun': dry_run,
            'entries': entries,
            'metadata': {
                'source': 'libreoffice',
                'sheetName': sheet_name,
                'configSheet': CONFIG_SHEET_NAME
            }
        }

        client = AutomationClient(config, integration=INTEGRATION, requested_by=_current_user_email)
        try:
            response = client.post_job('scripts/tariff.import-catalog/jobs', payload)
        except AutomationError as err:
            notify(f'Import tariffs failed: {err}', document=doc)
            return

        job = response.get('job', {})
        summary = job.get('summary', '')
        message = f"Job {job.get('id', 'unknown')} enregistré ({job.get('status', 'queued')})."
        if summary:
            message += f"\n{summary}"
        notify(message, document=doc)


g_exportedScripts = (import_tariffs_from_calc,)
