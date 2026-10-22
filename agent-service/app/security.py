import re
from typing import Any

SECRET_KEY_RE = re.compile(
    r"(authorization|token|password|secret|user_data|userdata|console|cookie|key_data)",
    re.IGNORECASE,
)


def redact(value: Any, key: str = "") -> Any:
    """Remove cloud credentials and potentially executable bootstrap data."""
    if SECRET_KEY_RE.search(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(k): redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return value[:4000] + ("…[TRUNCATED]" if len(value) > 4000 else "")
    return value


def safe_text(value: str) -> str:
    return redact(value) if isinstance(redact(value), str) else "[REDACTED]"
