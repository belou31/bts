"""
automation_client — shared client for the BTS `/api/automation` API.

Used by every `scripts_desktop/` surface (LibreOffice Calc macros, the local
CLI, ...) so JWT signing, config resolution, and HTTP plumbing aren't
duplicated per surface.
"""

from .config import AutomationConfig, DEFAULT_CONFIG_SHEET, lookup_config, resolve_flag, resolve_setting
from .env_loader import default_env_path, ensure_loaded as ensure_env_loaded
from .http_client import AutomationClient, AutomationError
from .jwt_signer import create_jwt
from .log_utils import capture_logs, current_log_path
from .sheet_utils import normalize_cell_value, parse_bool

__all__ = [
    'AutomationClient',
    'AutomationConfig',
    'AutomationError',
    'DEFAULT_CONFIG_SHEET',
    'capture_logs',
    'create_jwt',
    'current_log_path',
    'default_env_path',
    'ensure_env_loaded',
    'lookup_config',
    'normalize_cell_value',
    'parse_bool',
    'resolve_flag',
    'resolve_setting',
]
