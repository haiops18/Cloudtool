from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.api.routers import agent_project_actions as actions
from app.models import Role
from app.provisioning.router import agent_validate_deployment, validate_agent_deployment
from app.provisioning.schemas import DeploymentCreate


@pytest.fixture
def environment(monkeypatch):
    monkeypatch.setattr(actions, "_private_allocations", {})
    monkeypatch.setattr(actions.get_settings(), "AGENT_SERVICE_BACKEND_KEY", "service-key")
    user = SimpleNamespace(id="u", role=Role.admin, permissions=[], cloud_api_access="full")
    request = Request({"type": "http", "headers": [(b"x-agent-service-key", b"service-key")]})
    return user, request, ("p", "token", None), SimpleNamespace(add=Mock(), commit=AsyncMock())


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,parameters,result_key", [
    ("elastic-ip", {"zone_id": "z1"}, "elastic"),
])
async def test_ip_creation_reuses_manual_allocator(monkeypatch, environment, kind, parameters, result_key):
    user, request, context, db = environment
    allocation = {"status": "completed", "ip_id": "real-ip", "ip_address": "10.0.0.8"}
    allocate = AsyncMock(return_value={"items": [{result_key: allocation}]})
    monkeypatch.setattr(actions, "create_manual_ips", allocate)
    payload = actions.IpCreate(request_id=uuid4(), **parameters)
    assert await actions.create_ip(kind, payload, request, context, user, db) == {**allocation, "zone_id": "z1"}
    batch = allocate.await_args.args[0]
    assert batch.request_id == payload.request_id and batch.max_attempts == 1
    assert batch.items[0].create_private == (kind == "private-ip")


@pytest.mark.asyncio
async def test_private_address_is_checked_before_write(monkeypatch, environment):
    user, request, context, db = environment
    monkeypatch.setattr(actions.cloud_v1, "call", AsyncMock(return_value=({"project": "p", "cidr": "10.0.0.0/24"}, 200)))
    create = AsyncMock(return_value=({"id": "ip1", "ip_address": "10.0.0.8", "server": None, "project": "p"}, 201))
    monkeypatch.setattr(actions.cloud_v1, "create_resource", create)
    monkeypatch.setattr(actions, "write_audit", AsyncMock())
    for address in ("10.0.0.1", "10.0.1.8", "10.0.0.255"):
        with pytest.raises(HTTPException) as invalid:
            await actions.create_ip("private-ip", actions.IpCreate(request_id=uuid4(), subnet_id="s", ip_address=address), request, context, user, db)
        assert invalid.value.status_code == 422
    assert not create.await_count
    result = await actions.create_ip("private-ip", actions.IpCreate(request_id=uuid4(), subnet_id="s", ip_address="10.0.0.8"), request, context, user, db)
    assert result["ip_id"] == "ip1"
    assert create.await_args.args[5] == {"ip_address": "10.0.0.8", "description": "", "subnet": "s"}


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,suffix,key", [("private-ip", "attach-privateip", "privateip"), ("elastic-ip", "attach-eip", "eip")])
async def test_attachment_uses_exact_resources_and_project(monkeypatch, environment, kind, suffix, key):
    user, request, context, db = environment
    call = AsyncMock(side_effect=[
        ({"id": "vm", "project": "p", "zone": "z"}, 200),
        ({"id": "ip", "project": "p", "region": "r", "server": None, "description": ""}, 200),
        ({"results": [{"id": "z", "region": {"id": "r", "name": "Region"}}]}, 200),
        ({}, 202),
    ])
    monkeypatch.setattr(actions.cloud_v1, "call", call)
    monkeypatch.setattr(actions, "write_audit", AsyncMock())
    result = await actions.attach_ip(kind, actions.IpAttach(server_id="vm", ip_id="ip"), request, context, user, db)
    assert result["status"] == "accepted"
    assert call.await_args.args[3:6] == ("POST", f"/legacy/api/infra/servers/vm/{suffix}/", "p")
    assert call.await_args.kwargs["body"] == {key: "ip"}


@pytest.mark.asyncio
async def test_wrong_project_and_readonly_user_cannot_write(monkeypatch, environment):
    user, request, context, db = environment
    call = AsyncMock(side_effect=[({"project": "p", "zone": "z"}, 200), ({"project": "other", "server": None}, 200)])
    monkeypatch.setattr(actions.cloud_v1, "call", call)
    with pytest.raises(HTTPException) as mismatch:
        await actions.attach_ip("elastic-ip", actions.IpAttach(server_id="vm", ip_id="ip"), request, context, user, db)
    assert mismatch.value.status_code == 403
    assert all(args.args[3] == "GET" for args in call.await_args_list)
    user.cloud_api_access = "read_only"
    with pytest.raises(HTTPException) as readonly:
        actions.authorize(request, user)
    assert readonly.value.status_code == 403
    request = Request({"type": "http", "headers": []})
    with pytest.raises(HTTPException) as key:
        actions.authorize(request, user)
    assert key.value.status_code == 401


@pytest.mark.asyncio
async def test_vm_validation_requires_complete_configuration_before_approval(environment):
    user, request, context, db = environment
    body = DeploymentCreate(region="public", servers=[{"name": "vm", "subnet_id": "s"}])
    with pytest.raises(HTTPException) as incomplete:
        validate_agent_deployment(body, request, user)
    assert incomplete.value.status_code == 422
    body.servers[0].zone_id = "z"
    body.servers[0].image_id = "image"
    body.servers[0].flavor_name = "2c-4g"
    body.servers[0].disk_type = "SSD"
    result = await agent_validate_deployment(body, request, context, user, db)
    assert result["deployment"]["servers"][0]["zone_id"] == "z"
    assert not db.add.called
