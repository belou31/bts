"""
Thin HTTP client for the BTS `/api/automation` surface. Stdlib-only (urllib)
so it runs unmodified inside LibreOffice's bundled Python interpreter.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional, Union

from .config import AutomationConfig
from .jwt_signer import create_jwt


class AutomationError(RuntimeError):
    """Raised when the BTS automation API returns a non-2xx response."""


RequestedBy = Union[str, Callable[[], str]]


class AutomationClient:
    """Signs a fresh JWT per request and calls the BTS automation API."""

    def __init__(
        self,
        config: AutomationConfig,
        *,
        integration: str,
        requested_by: RequestedBy = 'automation-client',
        timeout: int = 30,
    ) -> None:
        self._config = config
        self._integration = integration
        self._requested_by = requested_by
        self._timeout = timeout

    def _resolve_requested_by(self) -> str:
        return self._requested_by() if callable(self._requested_by) else self._requested_by

    def _request(self, method: str, path: str, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        token = create_jwt(
            secret=self._config.secret,
            issuer=self._config.issuer,
            audience=self._config.audience,
            scopes=self._config.scopes,
            integration=self._integration,
            requested_by=self._resolve_requested_by(),
        )
        url = f"{self._config.base_url.rstrip('/')}/api/automation/{path.lstrip('/')}"
        data = json.dumps(payload).encode('utf-8') if payload is not None else None
        request = urllib.request.Request(
            url,
            data=data,
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                body = response.read().decode('utf-8')
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as err:
            detail = err.read().decode('utf-8')
            raise AutomationError(f'HTTP {err.code}: {detail}') from err
        except urllib.error.URLError as err:
            raise AutomationError(f'Connection failed: {err.reason}') from err

    def post_job(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """POST a job payload, e.g. path='scripts/tariff.import-catalog/jobs'."""
        return self._request('POST', path, payload)

    def get_job(self, job_id: str) -> Dict[str, Any]:
        """GET the current status/log of a previously submitted job."""
        return self._request('GET', f'jobs/{job_id}', None)

    def list_scripts(self) -> Dict[str, Any]:
        """GET the automation task catalog — read-only, no side effects; good for a connection test."""
        return self._request('GET', 'scripts', None)


__all__ = ['AutomationClient', 'AutomationError']
