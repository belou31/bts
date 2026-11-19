"""
Utility to load shared BTS automation settings into the process environment.

Secrets are stored outside the repository (default: ~/.config/bts/automation.env)
so they can be shared between Calc macros, local tooling, and other scripts
without being committed. Typical entries include `AUTOMATION_JWT_SECRET`,
`BTS_BASE_URL`, `AUTOMATION_JWT_ISS`, `AUTOMATION_JWT_AUD`, and
`AUTOMATION_JWT_SCOPES`. Values already present in the environment always win
to allow overrides.
"""

from __future__ import annotations

import os
import platform
from pathlib import Path
from typing import Optional

_LOADED_FROM: Optional[Path] = None


def default_env_path() -> Path:
    """
    OS-idiomatic default location for automation.env, used whenever
    BTS_AUTOMATION_ENV isn't set. Kept in one place so callers that need to
    know where credentials will be written/read (e.g. an installer) always
    agree with `ensure_loaded()`.
    """
    system = platform.system()
    if system == "Windows":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "bts" / "automation.env"
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / "bts" / "automation.env"
    return Path.home() / ".config" / "bts" / "automation.env"


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
    env_path = Path(candidate).expanduser() if candidate else default_env_path()

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


__all__ = ["ensure_loaded", "default_env_path"]
