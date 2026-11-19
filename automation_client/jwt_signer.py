"""
JWT (HS256) creation for the BTS automation API. Stdlib-only so this works
inside LibreOffice's bundled Python interpreter without extra dependencies.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Iterable, Optional


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def create_jwt(
    *,
    secret: str,
    issuer: str,
    audience: str,
    scopes: Iterable[str],
    integration: str,
    requested_by: Optional[str] = None,
    ttl_seconds: int = 600,
    nbf_skew_seconds: int = 30,
) -> str:
    """Sign a short-lived JWT for a single automation API call."""
    if not secret:
        raise RuntimeError('AUTOMATION_JWT_SECRET is missing.')
    now = int(time.time())
    header = {'alg': 'HS256', 'typ': 'JWT'}
    payload = {
        'iss': issuer,
        'aud': audience,
        'iat': now,
        'nbf': max(0, now - nbf_skew_seconds),
        'exp': now + ttl_seconds,
        'scopes': list(scopes),
        'integration': integration,
        'requestedBy': requested_by or integration,
    }
    signing_input = '.'.join([
        _b64url(json.dumps(header, separators=(',', ':')).encode('utf-8')),
        _b64url(json.dumps(payload, separators=(',', ':')).encode('utf-8')),
    ])
    signature = hmac.new(secret.encode('utf-8'), signing_input.encode('utf-8'), hashlib.sha256).digest()
    return f'{signing_input}.{_b64url(signature)}'


__all__ = ['create_jwt']
