import json
import logging
from typing import Any

from app.core.config import get_settings
from app.core.security import redact

logger = logging.getLogger("cloudtool.cloud_api")
SENSITIVE_HEADERS = {
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-cloud-token",
}


def _safe_details(details: dict[str, Any]) -> dict[str, Any]:
    value = dict(details)
    headers = value.get("headers")
    settings = get_settings()
    reveal_authorization = (
        settings.DEBUG
        and getattr(settings, "DEBUG_LOG_AUTHORIZATION", False)
        and getattr(settings, "APP_ENV", "development") != "production"
    )
    if isinstance(headers, dict):
        value["headers"] = {
            str(key): (
                "[REDACTED]"
                if str(key).lower() in SENSITIVE_HEADERS
                and not (
                    str(key).lower() == "authorization"
                    and reveal_authorization
                )
                else header_value
            )
            for key, header_value in headers.items()
        }
    safe = redact(value)
    if reveal_authorization and isinstance(headers, dict):
        for key, header_value in headers.items():
            if str(key).lower() == "authorization":
                safe.setdefault("headers", {})[str(key)] = header_value
    return safe


def cloud_debug(event: str, **details: Any) -> None:
    if not get_settings().DEBUG:
        return
    logger.warning(
        "[CLOUD API DEBUG] %s",
        json.dumps(
            {"event": event, **_safe_details(details)},
            ensure_ascii=False,
            default=str,
            indent=2,
        ),
    )
