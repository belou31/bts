"""
Helpers to read configuration overrides from a Calc worksheet.

Values in the environment remain authoritative (env wins). When an environment
variable is missing, the helper can fallback to the `BTS_Config` sheet (or a
custom sheet defined via `BTS_CONFIG_SHEET`).
"""

from __future__ import annotations

import os
from typing import Dict, Optional

DEFAULT_CONFIG_SHEET = os.environ.get('BTS_CONFIG_SHEET', 'BTS_Config')


def _normalize(value) -> str:
    if value is None:
        return ''
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return f'{value}'
    return str(value).strip()


def _slugify(name: str) -> str:
    return ''.join(ch.lower() for ch in name if not ch.isspace())


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
        key = _normalize(row[0])
        if not key or key.lower() == 'key':
            continue
        value = _normalize(row[1])
        key_l = key.lower()
        config[key_l] = value
        config[key_l.replace(' ', '')] = value
        config[key_l.replace('.', '_')] = value
        config[key_l.replace('.', '')] = value
        config[key_l.replace('_', '')] = value
    return config


def lookup_config(config: Dict[str, str], key: str, sheet_name: Optional[str] = None) -> str:
    """Find a value in the config map, supporting per-sheet overrides."""
    if not config or not key:
        return ''
    normalized_key = key.lower()
    candidates = []
    if sheet_name:
        slug = _slugify(sheet_name)
        if slug:
            candidates.append(f'{normalized_key}.{slug}')
    candidates.append(normalized_key)
    for candidate in candidates:
        if candidate in config and config[candidate]:
            return config[candidate]
    return ''


def resolve_setting(
    env_key: str,
    config: Dict[str, str],
    *,
    sheet_name: Optional[str] = None,
    aliases: Optional[tuple[str, ...]] = None,
    default: Optional[str] = None,
) -> str:
    """
    Resolve a configuration value with the following precedence:
        1. Existing environment variable (`env_key`).
        2. Matching entry in the config sheet (`aliases`).
        3. Provided default.

    Whenever a value is resolved from the config sheet, the corresponding
    environment variable is populated for the remainder of the session so that
    downstream helpers continue to consume it transparently.
    """
    if env_key:
        current = os.environ.get(env_key)
        if current not in (None, ''):
            return current

    search_keys = [env_key] if env_key else []
    if aliases:
        search_keys.extend(aliases)

    for alias in search_keys:
        candidate = lookup_config(config, alias, sheet_name)
        if candidate:
            if env_key:
                os.environ[env_key] = candidate
            return candidate

    if env_key and default not in (None, ''):
        os.environ.setdefault(env_key, default)
    return default or ''


__all__ = ['load_config_map', 'lookup_config', 'resolve_setting', 'DEFAULT_CONFIG_SHEET']
