"""
Utility to load shared BTS automation secrets into the LibreOffice macro runtime.

Secrets are stored outside the repository (default: ~/.config/bts/automation.env)
so they can be shared between Calc macros and external tooling without being
committed. Values in the current environment always win to allow overrides.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

_LOADED_FROM: Optional[Path] = None


def _parse_line(line: str) -> Optional[tuple[str, str]]:
    """Return key/value from a line in KEY=VALUE format."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None

    if "=" not in stripped:
        return None

    key, value = stripped.split("=", 1)
    key = key.strip()
    if not key:
        return None

    value = value.strip().strip('"').strip("'")
    return key, value


def ensure_loaded() -> Optional[Path]:
    """
    Load shared automation secrets once.

    Returns the path secrets were loaded from, or None if no file was found.
    """
    global _LOADED_FROM  # noqa: PLW0603
    if _LOADED_FROM:
        return _LOADED_FROM

    candidate = os.environ.get("BTS_AUTOMATION_ENV")
    if candidate:
        env_path = Path(candidate).expanduser()
    else:
        env_path = Path.home() / ".config" / "bts" / "automation.env"

    if not env_path.is_file():
        return None

    try:
        with env_path.open("r", encoding="utf-8") as handle:
            for raw in handle:
                parsed = _parse_line(raw)
                if not parsed:
                    continue
                key, value = parsed
                os.environ.setdefault(key, value)
        _LOADED_FROM = env_path
        return env_path
    except OSError:
        return None


__all__ = ["ensure_loaded"]
