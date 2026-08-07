"""
LibreOffice Calc macro — Import tariff price catalog via BTS automation API.
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
        lookup_config,
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
        lookup_config,
        normalize_cell_value,
        resolve_flag,
    )

ensure_env_loaded()

INTEGRATION = 'libreoffice-calc'
DEFAULT_SCOPES = ('automation:jobs:write', 'automation:jobs:run', 'automation:events:write')
SHEET_NAME = os.environ.get('BTS_TARIFF_PRICES_SHEET', 'TariffPrices')
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


def _collect_entries(sheet, config_map: Dict[str, str], sheet_name: str):
    data = _sheet_data(sheet)
    if len(data) <= 1:
        return [], '', ''

    headers = [normalize_cell_value(h).lower() for h in data[0]]
    index = {name: idx for idx, name in enumerate(headers) if name}

    catalog_default = lookup_config(config_map, 'tariff.prices.slug', sheet_name)
    venue_default = lookup_config(config_map, 'tariff.prices.venue', sheet_name)

    def get(row, key):
        idx = index.get(key.lower())
        if idx is None or idx >= len(row):
            return ''
        return row[idx]

    entries = []
    for row in data[1:]:
        catalog_slug = normalize_cell_value(get(row, 'catalogslug') or get(row, 'catalog')).lower()
        if not catalog_slug and catalog_default:
            catalog_slug = catalog_default.lower()
        zone_key = normalize_cell_value(get(row, 'zonekey') or get(row, 'zone')).upper()
        tariff_code = normalize_cell_value(get(row, 'tariffcode') or get(row, 'tariff') or get(row, 'code')).upper()
        if not catalog_slug or not zone_key or not tariff_code:
            continue

        entry = {
            'catalogSlug': catalog_slug,
            'venueSlug': (normalize_cell_value(get(row, 'venueslug')) or venue_default).strip() or None,
            'zoneKey': zone_key,
            'tariffCode': tariff_code,
            'priceCents': normalize_cell_value(get(row, 'pricecents')),
            'priceEuro': normalize_cell_value(get(row, 'priceeuro') or get(row, 'price')),
            'currency': normalize_cell_value(get(row, 'currency')) or 'EUR',
            'channels': normalize_cell_value(get(row, 'channels') or get(row, 'channel') or get(row, 'scopes'))
        }
        entries.append(entry)

    return entries, (catalog_default.lower() if catalog_default else ''), venue_default


def import_tariff_prices_from_calc() -> None:
    with capture_logs('import-tariff-prices'):
        doc = XSCRIPTCONTEXT.getDocument()
        sheet = _sheet_by_name(doc, SHEET_NAME) or doc.CurrentController.ActiveSheet
        sheet_name = getattr(sheet, 'Name', SHEET_NAME)

        config_map = load_config_map(doc, CONFIG_SHEET_NAME)
        config = AutomationConfig.from_env(
            default_issuer='libreoffice', default_scopes=DEFAULT_SCOPES
        ).apply_overrides(config_map, sheet_name=sheet_name)
        dry_run = resolve_flag(
            'BTS_TARIFF_PRICES_DRY_RUN', config_map, sheet_name=sheet_name,
            aliases=('tariff.prices.dryrun', 'tariff_prices_dry_run', 'bts_tariff_prices_dry_run'),
            default=True,
        )
        append_flag = resolve_flag(
            'BTS_TARIFF_PRICES_APPEND', config_map, sheet_name=sheet_name,
            aliases=('tariff.prices.append', 'tariff_prices_append', 'bts_tariff_prices_append'),
            default=False,
        )

        entries, default_catalog, default_venue = _collect_entries(sheet, config_map, sheet_name)
        if not entries:
            notify('Aucune ligne valide (catalogSlug, zoneKey, tariffCode, prix) détectée.', document=doc)
            return

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

        client = AutomationClient(config, integration=INTEGRATION, requested_by=_current_user_email)
        try:
            response = client.post_job('scripts/tariff.import-prices/jobs', payload)
        except AutomationError as err:
            notify(f'Import tariff prices failed: {err}', document=doc)
            return

        job = response.get('job', {})
        summary = job.get('summary', '')
        message = f"Job {job.get('id', 'unknown')} enregistré ({job.get('status', 'queued')})."
        if summary:
            message += f"\n{summary}"
        notify(message, document=doc)


g_exportedScripts = (import_tariff_prices_from_calc,)
