"""Narrow, secret-safe gateway for Dolphin resource ingestion."""

from typing import Any

import httpx
from fastapi import HTTPException

from app.core.config import get_settings


async def ingest_resources(action: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    """Send at most one Dolphin-compatible batch without exposing its API key."""
    settings = get_settings()
    if not settings.DOLPHIN_API_KEY:
        raise HTTPException(503, "Dolphin integration is not configured")
    if len(items) > 500:
        raise HTTPException(400, "Dolphin accepts at most 500 resources per request")
    try:
        async with httpx.AsyncClient(
            base_url=settings.DOLPHIN_BASE_URL,
            timeout=httpx.Timeout(settings.DOLPHIN_TIMEOUT_SECONDS),
            follow_redirects=False,
            trust_env=False,
        ) as client:
            response = await client.post(
                settings.DOLPHIN_INGEST_PATH,
                headers={
                    "X-Dolphin-Key": settings.DOLPHIN_API_KEY,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={"source": settings.DOLPHIN_SOURCE, "action": action, "items": items},
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(504, "Dolphin request timed out") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Dolphin request failed: {exc}") from exc
    try:
        payload = response.json()
    except ValueError:
        payload = {"message": response.text[:1000]}
    if response.is_error:
        raise HTTPException(
            502,
            {
                "message": "Dolphin rejected the resource batch",
                "upstream_status": response.status_code,
                "upstream_detail": payload,
            },
        )
    if not isinstance(payload, dict):
        raise HTTPException(502, "Dolphin returned an unsupported response")
    return payload
