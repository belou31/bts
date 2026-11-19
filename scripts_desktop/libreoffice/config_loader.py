"""
LibreOffice Calc-specific: read configuration overrides from a Calc worksheet.

Generic precedence rules (`resolve_setting`, `lookup_config`, `resolve_flag`)
now live in `automation_client.config`, shared with any other automation
client; this module keeps only the UNO-specific part — turning a `BTS_Config`
sheet into a plain key/value map.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Dict, Optional

try:
    from automation_client import DEFAULT_CONFIG_SHEET, normalize_cell_value
except ImportError:
    repo_root = Path(__file__).resolve().parent.parent.parent
    if str(repo_root) not in sys.path:
        sys.path.append(str(repo_root))
    from automation_client import DEFAULT_CONFIG_SHEET, normalize_cell_value  # type: ignore

# Re-exported for callers that still import resolution helpers from this module.
from automation_client import lookup_config, resolve_setting  # noqa: E402


def load_config_map(doc, sheet_name: Optional[str] = None) -> Dict[str, str]:
    """Return key/value pairs from the configuration sheet."""
    target_name = sheet_name or DEFAULT_CONFIG_SHEET
    if not target_name:
        return {}
    try:
        sheet = doc.Sheets.getByName(target_name)
    except Exception:
        return {}

    cursor = sheet.createCursor()
    cursor.gotoEndOfUsedArea(True)
    rng = sheet.getCellRangeByPosition(
        0,
        0,
        cursor.RangeAddress.EndColumn,
        cursor.RangeAddress.EndRow,
    )
    data = rng.getDataArray()

    config: Dict[str, str] = {}
    for row in data:
        if not row or len(row) < 2:
            continue
        key = normalize_cell_value(row[0])
        if not key or key.lower() == 'key':
            continue
        value = normalize_cell_value(row[1])
        key_l = key.lower()
        config[key_l] = value
        config[key_l.replace(' ', '')] = value
        config[key_l.replace('.', '_')] = value
        config[key_l.replace('.', '')] = value
        config[key_l.replace('_', '')] = value
    return config


__all__ = ['load_config_map', 'lookup_config', 'resolve_setting', 'DEFAULT_CONFIG_SHEET']
