import hashlib
import re
import secrets
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

hasher = PasswordHasher()
SENSITIVE = {"authorization", "x-cloud-token", "token", "password", "secret", "new_password"}


def hash_password(value: str) -> str:
    return hasher.hash(value)


def verify_password(value: str, encoded: str) -> bool:
    try:
        return hasher.verify(encoded, value)
    except (VerifyMismatchError, InvalidHashError):
        return False


def random_token() -> str:
    return secrets.token_urlsafe(48)


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def validate_server_password(value: str) -> str:
    checks = [
        len(value) > 8,
        any(c.isupper() for c in value),
        any(c.islower() for c in value),
        any(c.isdigit() for c in value),
        any(not c.isalnum() for c in value),
    ]
    if not all(checks):
        raise ValueError("Password must be >8 chars with upper, lower, number and special char")
    return value


def _sensitive(key: str) -> bool:
    key = key.lower().replace("-", "_")
    return any(item.replace("-", "_") in key for item in SENSITIVE)


def redact_url(value: str) -> str:
    try:
        parts = urlsplit(value)
        if not parts.netloc:
            return value
        query = [
            (k, "[REDACTED]" if _sensitive(k) or "console" in parts.path else v)
            for k, v in parse_qsl(parts.query, keep_blank_values=True)
        ]
        path = re.sub(r"(?i)(token[=/])[^/?&]+", r"\1[REDACTED]", parts.path)
        return urlunsplit((parts.scheme, parts.netloc, path, urlencode(query), ""))
    except ValueError:
        return "[INVALID_URL]"


def redact(value: Any, key: str = "") -> Any:
    if _sensitive(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(k): redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, str):
        value = redact_url(value) if value.startswith(("http://", "https://")) else value
        return value[:16_384] + ("...[TRUNCATED]" if len(value) > 16_384 else "")
    return value
