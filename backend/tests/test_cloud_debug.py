import json
import logging
from types import SimpleNamespace

from app.gateway import debug
from app.gateway.client import cloud_headers, curl_preview


def test_cloud_debug_is_silent_when_disabled(monkeypatch, caplog):
    monkeypatch.setattr(debug, "get_settings", lambda: SimpleNamespace(DEBUG=False))
    with caplog.at_level(logging.WARNING, logger="cloudtool.cloud_api"):
        debug.cloud_debug("request", method="GET")
    assert not caplog.records


def test_cloud_debug_prints_details_and_redacts_secrets(monkeypatch, caplog):
    monkeypatch.setattr(
        debug,
        "get_settings",
        lambda: SimpleNamespace(
            DEBUG=True,
            DEBUG_LOG_AUTHORIZATION=False,
            APP_ENV="development",
        ),
    )
    with caplog.at_level(logging.WARNING, logger="cloudtool.cloud_api"):
        debug.cloud_debug(
            "request",
            method="POST",
            url="https://cloud.example.test/servers",
            headers={
                "Authorization": "Token private-value",
                "Set-Cookie": "session=private-cookie",
            },
            body={"name": "server-1", "password": "Strong@123"},
        )

    message = caplog.records[0].getMessage()
    payload = json.loads(message.removeprefix("[CLOUD API DEBUG] "))
    assert payload["event"] == "request"
    assert payload["method"] == "POST"
    assert payload["body"]["name"] == "server-1"
    assert payload["body"]["password"] == "[REDACTED]"
    assert payload["headers"]["Authorization"] == "[REDACTED]"
    assert payload["headers"]["Set-Cookie"] == "[REDACTED]"
    assert "private-value" not in message
    assert "Strong@123" not in message
    assert "private-cookie" not in message


def test_cloud_debug_can_reveal_authorization_in_local_debug(monkeypatch, caplog):
    monkeypatch.setattr(
        debug,
        "get_settings",
        lambda: SimpleNamespace(
            DEBUG=True,
            DEBUG_LOG_AUTHORIZATION=True,
            APP_ENV="development",
        ),
    )
    with caplog.at_level(logging.WARNING, logger="cloudtool.cloud_api"):
        debug.cloud_debug(
            "request",
            headers={
                "Authorization": "Token private-value",
                "Cookie": "session=private-cookie",
            },
        )

    message = caplog.records[0].getMessage()
    payload = json.loads(message.removeprefix("[CLOUD API DEBUG] "))
    assert payload["headers"]["Authorization"] == "Token private-value"
    assert payload["headers"]["Cookie"] == "[REDACTED]"


def test_cloud_debug_never_reveals_authorization_in_production(monkeypatch, caplog):
    monkeypatch.setattr(
        debug,
        "get_settings",
        lambda: SimpleNamespace(
            DEBUG=True,
            DEBUG_LOG_AUTHORIZATION=True,
            APP_ENV="production",
        ),
    )
    with caplog.at_level(logging.WARNING, logger="cloudtool.cloud_api"):
        debug.cloud_debug(
            "request",
            headers={"Authorization": "Token private-value"},
        )

    assert "private-value" not in caplog.records[0].getMessage()


def test_cloud_headers_match_required_curl_format():
    headers = cloud_headers("Token private-token", "correlation-1", "project-1")

    assert headers == {
        "Authorization": "Token private-token",
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "User-Agent": "curl/8.10.1",
        "Cookie": "NEXT_LOCALE=vi",
        "project-id": "project-1",
    }


def test_cloud_headers_omit_project_only_for_bootstrap_calls():
    headers = cloud_headers("Token private-token", "correlation-1", None)

    assert "project-id" not in headers
    assert headers["Authorization"] == "Token private-token"
    assert headers["Content-Type"] == "application/json"


def test_cloud_headers_normalize_raw_viettel_token():
    headers = cloud_headers("private-token", "correlation-1", "project-1")

    assert headers["Authorization"] == "Token private-token"


def test_cloud_headers_preserve_explicit_authorization_scheme():
    headers = cloud_headers("Bearer private-token", "correlation-1", "project-1")

    assert headers["Authorization"] == "Bearer private-token"


def test_curl_preview_is_reproducible_without_exposing_secrets():
    preview = curl_preview(
        "POST",
        "https://cloud.example.test/share?token=query-secret",
        cloud_headers("Token private-token", "correlation-1", "project-1"),
        {"projects": ["project-2"], "password": "Strong@123"},
    )

    assert "curl --location" in preview
    assert "project-id: project-1" in preview
    assert "Content-Type: application/json" in preview
    assert '\\"projects\\"' in preview
    assert "private-token" not in preview
    assert "query-secret" not in preview
    assert "Strong@123" not in preview
    assert "[REDACTED]" in preview


def test_curl_preview_can_reveal_only_authorization():
    preview = curl_preview(
        "POST",
        "https://cloud.example.test/servers",
        {
            **cloud_headers("Token private-token", "correlation-1", "project-1"),
            "Cookie": "session=private-cookie",
        },
        {"password": "Strong@123"},
        reveal_authorization=True,
    )

    assert "Authorization: Token private-token" in preview
    assert "private-cookie" not in preview
    assert "Strong@123" not in preview
