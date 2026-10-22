from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from app.gateway.adapters import ViettelCloudV1
from app.models import AuditLog, CloudApiLog, Role


@pytest.mark.asyncio
async def test_create_resource_uses_common_gateway(monkeypatch):
    request = AsyncMock(return_value=({"id": "server-1"}, 201))
    monkeypatch.setattr("app.gateway.adapters.gateway.request", request)
    adapter = ViettelCloudV1()
    db = SimpleNamespace()
    user = SimpleNamespace(role=Role.admin, permissions=[], cloud_api_access="full")

    result = await adapter.create_resource(
        db, user, "Token cloud-token", "project-1", "servers", {"name": "app-01"}
    )

    assert result == ({"id": "server-1"}, 201)
    request.assert_awaited_once_with(
        db,
        user,
        "Token cloud-token",
        "POST",
        "/legacy/api/infra/servers/",
        project_id="project-1",
        params=None,
        body={"name": "app-01"},
        approval_id=None,
        request_timeout=None,
    )


@pytest.mark.parametrize("status", [201, 400])
async def test_elastic_create_uses_gateway_and_records_api_and_audit_logs(monkeypatch, status):
    from fastapi import HTTPException

    from app.gateway.client import gateway, settings

    monkeypatch.setattr(settings, "DEBUG_CLOUD_APPROVAL_MODE", False)
    response = httpx.Response(status, json={"id": "eip", "ip_address": "171.254.94.38"}, request=httpx.Request("POST", "https://console.viettelcloud.vn/legacy/api/infra/elastic-ips/"))
    send = AsyncMock(return_value=response)
    monkeypatch.setattr(gateway, "_send", send)
    records = []
    db = SimpleNamespace(add=records.append, commit=AsyncMock())
    user = SimpleNamespace(id="user", email="user@example.test", role=Role.admin, permissions=[], cloud_api_access="full")
    if status == 201:
        await ViettelCloudV1().create_elastic_ip(db, user, "test-token", "project", "region", "approval")
    else:
        with pytest.raises(HTTPException):
            await ViettelCloudV1().create_elastic_ip(db, user, "test-token", "project", "region", "approval")
    assert send.call_args.args[0:2] == ("POST", "/legacy/api/infra/elastic-ips/")
    assert send.call_args.args[4] == {"region": "region", "enable_ipv6": False}
    log = next(item for item in records if isinstance(item, CloudApiLog))
    assert log.project_id == "project"
    assert log.http_status == status
    audit = next(item for item in records if isinstance(item, AuditLog))
    assert audit.action == "cloud.elastic_ip.create"
    assert audit.result == ("success" if status == 201 else "failed")
