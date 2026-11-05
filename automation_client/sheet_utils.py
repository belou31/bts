"""
Small helpers for turning raw spreadsheet cell values (as returned by
LibreOffice's UNO ``getDataArray()``, or any similarly shaped tabular source)
into plain Python strings/booleans.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any


def normalize_cell_value(value: Any) -> str:
    if value is None:
        return ''
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return f'{value}'
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value).strip()


def parse_bool(value: Any, default: bool) -> bool:
    if value is None or value == '':
        return default
    text = str(value).strip().lower()
    if not text:
        return default
    if text in {'1', 'true', 'yes', 'y', 'on'}:
        return True
    if text in {'0', 'false', 'no', 'n', 'off'}:
        return False
    return default


__all__ = ['normalize_cell_value', 'parse_bool']
