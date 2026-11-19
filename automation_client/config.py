"""
Configuration resolution shared across BTS automation clients (LibreOffice
macros, local tooling, ...).

Precedence, matching the behaviour the LibreOffice macros already relied on:
    1. Current environment variable (wins if set).
    2. A caller-supplied override map (e.g. values read from a `BTS_Config`
       worksheet), optionally scoped per sheet via a `<key>.<sheet>` alias.
    3. The provided default.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, replace
from typing import Dict, Optional, Sequence, Tuple

from .sheet_utils import parse_bool

DEFAULT_CONFIG_SHEET = os.environ.get('BTS_CONFIG_SHEET', 'BTS_Config')


def _slugify(name: str) -> str:
    return ''.join(ch.lower() for ch in name if not ch.isspace())


def lookup_config(config: Dict[str, str], key: str, sheet_name: Optional[str] = None) -> str:
    """Find a value in a config map, supporting per-sheet overrides (key.<sheet>)."""
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
    aliases: Optional[Tuple[str, ...]] = None,
    default: Optional[str] = None,
) -> str:
    """
    Resolve a configuration value with the following precedence:
        1. Existing environment variable (`env_key`).
        2. Matching entry in the config map (`aliases`).
        3. Provided default.

    Whenever a value is resolved from the config map, the corresponding
    environment variable is populated for the remainder of the process so
    downstream helpers keep seeing it transparently.
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


def resolve_flag(
    env_key: str,
    config: Dict[str, str],
    *,
    sheet_name: Optional[str] = None,
    aliases: Optional[Tuple[str, ...]] = None,
    default: bool,
) -> bool:
    """Same precedence as `resolve_setting`, parsed as a boolean flag."""
    raw = resolve_setting(
        env_key, config, sheet_name=sheet_name, aliases=aliases,
        default='true' if default else 'false',
    )
    return parse_bool(raw, default)


@dataclass(frozen=True)
class AutomationConfig:
    """Base URL + JWT signing material for calling the BTS automation API."""

    base_url: str
    secret: str
    issuer: str
    audience: str
    scopes: Tuple[str, ...]

    @classmethod
    def from_env(
        cls,
        *,
        default_issuer: str = 'automation-client',
        default_audience: str = 'bts-automation',
        default_scopes: Sequence[str] = ('automation:jobs:write', 'automation:jobs:run'),
        default_base_url: str = 'http://127.0.0.1:8080',
    ) -> 'AutomationConfig':
        return cls(
            base_url=os.environ.get('BTS_BASE_URL', default_base_url),
            secret=os.environ.get('AUTOMATION_JWT_SECRET', ''),
            issuer=os.environ.get('AUTOMATION_JWT_ISS', default_issuer),
            audience=os.environ.get('AUTOMATION_JWT_AUD', default_audience),
            scopes=tuple(os.environ.get('AUTOMATION_JWT_SCOPES', ' '.join(default_scopes)).split()),
        )

    def apply_overrides(self, config_map: Dict[str, str], *, sheet_name: Optional[str] = None) -> 'AutomationConfig':
        """Re-resolve every field against `config_map`, keeping env-var precedence."""
        base_url = resolve_setting(
            'BTS_BASE_URL', config_map, sheet_name=sheet_name,
            aliases=('base.url', 'base_url', 'bts_base_url'), default=self.base_url,
        )
        secret = resolve_setting(
            'AUTOMATION_JWT_SECRET', config_map, sheet_name=sheet_name,
            aliases=('automation.secret', 'automation.jwt.secret', 'automation_jwt_secret'), default=self.secret,
        )
        issuer = resolve_setting(
            'AUTOMATION_JWT_ISS', config_map, sheet_name=sheet_name,
            aliases=('jwt.iss', 'automation.jwt.iss', 'automation_jwt_iss'), default=self.issuer,
        )
        audience = resolve_setting(
            'AUTOMATION_JWT_AUD', config_map, sheet_name=sheet_name,
            aliases=('jwt.aud', 'automation.jwt.aud', 'automation_jwt_aud'), default=self.audience,
        )
        scopes_raw = resolve_setting(
            'AUTOMATION_JWT_SCOPES', config_map, sheet_name=sheet_name,
            aliases=('jwt.scopes', 'automation.jwt.scopes', 'automation_jwt_scopes'), default=' '.join(self.scopes),
        )
        return replace(
            self,
            base_url=base_url or self.base_url,
            secret=secret or self.secret,
            issuer=issuer or self.issuer,
            audience=audience or self.audience,
            scopes=tuple(scopes_raw.split()) if scopes_raw else self.scopes,
        )


__all__ = [
    'DEFAULT_CONFIG_SHEET',
    'lookup_config',
    'resolve_setting',
    'resolve_flag',
    'AutomationConfig',
]
