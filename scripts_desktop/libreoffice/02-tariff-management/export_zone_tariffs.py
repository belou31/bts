"""
LibreOffice Calc macro — Export zone tariffs (prices per zone) via BTS
automation API. Writes into a sheet, not a CSV file — a spreadsheet app is
the destination, so the spreadsheet's own sheet is the natural output.
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
        resolve_setting,
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
        resolve_setting,
    )

ensure_env_loaded()

INTEGRATION = 'libreoffice-calc'
DEFAULT_SCOPES = ('automation:jobs:write', 'automation:jobs:run')
SHEET_NAME = os.environ.get('BTS_ZONE_TARIFFS_SHEET', 'ZoneTariffs')
CONFIG_SHEET_NAME = os.environ.get('BTS_CONFIG_SHEET', 'BTS_Config')

HEADERS = ['zoneKey', 'tariffCode', 'priceCents', 'priceEuro', 'partnerPriceCents', 'partnerPriceEuro', 'currency']


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
        1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256
    )

    for col, header in enumerate(HEADERS):
        sheet.getCellByPosition(col, 0).setString(header)

    for row, entry in enumerate(entries, start=1):
        for col, header in enumerate(HEADERS):
            cell = sheet.getCellByPosition(col, row)
            value = entry.get(header, '')
            if header in ('priceCents', 'partnerPriceCents') and value not in (None, ''):
                cell.setValue(float(value))
            else:
                cell.setString('' if value is None else str(value))


def export_zone_tariffs_from_calc() -> None:
    with capture_logs('export-zone-tariffs'):
        doc = XSCRIPTCONTEXT.getDocument()
        sheet = _sheet_by_name(doc, SHEET_NAME) or doc.CurrentController.ActiveSheet
        sheet_name = getattr(sheet, 'Name', SHEET_NAME)

        config_map = load_config_map(doc, CONFIG_SHEET_NAME)
        config = AutomationConfig.from_env(
            default_issuer='libreoffice', default_scopes=DEFAULT_SCOPES
        ).apply_overrides(config_map, sheet_name=sheet_name)

        season_code = resolve_setting(
            'SEASON_CODE', config_map, sheet_name=sheet_name,
            aliases=('zone.tariffs.season', 'season.code'),
            default=os.environ.get('SEASON_CODE', ''),
        )
        venue_slug = resolve_setting(
            'VENUE_SLUG', config_map, sheet_name=sheet_name,
            aliases=('zone.tariffs.venue', 'venue.slug'),
            default=os.environ.get('VENUE_SLUG', ''),
        )
        if not season_code or not venue_slug:
            notify(
                'Renseignez SEASON_CODE et VENUE_SLUG (variables d’environnement, ou clés '
                '"zone.tariffs.season" / "zone.tariffs.venue" dans la feuille BTS_Config).',
                document=doc,
            )
            return

        payload = {
            'runMode': 'sync',
            'params': {'seasonCode': season_code, 'venueSlug': venue_slug},
            'metadata': {'source': 'libreoffice', 'sheetName': sheet_name},
        }

        client = AutomationClient(config, integration=INTEGRATION, requested_by=_current_user_email)
        try:
            response = client.post_job('scripts/tariff.export-zone-tariffs/jobs', payload)
        except AutomationError as err:
            notify(f'Export failed: {err}', document=doc)
            return

        job = response.get('job', {})
        if job.get('status') != 'succeeded':
            error = job.get('error') or {}
            notify(f"Export failed: {error.get('message', job.get('status', 'unknown error'))}", document=doc)
            return

        entries = ((job.get('result') or {}).get('payload') or {}).get('entries', [])
        _write_entries(sheet, entries)
        notify(
            f'Export : {len(entries)} prix rapatriés dans "{sheet_name}" '
            f'({season_code} / {venue_slug}).',
            document=doc,
        )


g_exportedScripts = (export_zone_tariffs_from_calc,)
