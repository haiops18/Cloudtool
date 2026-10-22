from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from fastapi import BackgroundTasks, HTTPException
from starlette.requests import Request

from app.api.routers import agent_project_actions as actions
from app.models import Role
from app.provisioning import router
from app.provisioning.agent_network import validate_allocated_network
from app.provisioning.schemas import DeploymentCreate


def deployment(servers=None):
    return DeploymentCreate(region="public", servers=servers or [{
        "name": "vm", "zone_id": "z", "image_name": "Ubuntu", "disk_type": "SSD", "flavor_name": "small",
        "subnet_id": "s", "private_ip_mode": "existing", "eni_id": "ip", "elastic_ip_mode": "existing", "elastic_ip_id": "eip",
    }])


@pytest.fixture
def api(monkeypatch):
    rows = {
        "/legacy/api/organization/zones/": {"results": [{"id": "z", "region": {"id": "r", "name": "public"}}]},
        "/legacy/api/infra/subnets/s/": {"id": "s", "project": "p", "cidr": "10.0.0.0/24"},
        "/legacy/api/infra/private-ips/ip/": {"id": "ip", "project": "p", "region": "public", "subnet": "s", "ip_address": "10.0.0.8", "server": None, "description": ""},
        "/legacy/api/infra/elastic-ips/eip/": {"id": "eip", "project": "p", "region": "r", "ip_address": "203.0.113.8", "server": None},
    }
    async def call(db, user, token, method, path, project, **kwargs):
        assert method == "GET" and project == "p"
        return rows[path], 200
    mock = AsyncMock(side_effect=call)
    monkeypatch.setattr(actions.cloud_v1, "call", mock)
    return rows, mock


@pytest.mark.asyncio
async def test_preallocated_ips_become_create_payload_without_attach_calls(api, monkeypatch):
    from app.provisioning.service import _create_server
    rows, call = api
    body = deployment()
    await validate_allocated_network(body, ("p", "t", None), "user", "db")
    server = body.servers[0]
    assert server.eni_address == "10.0.0.8"
    assert server.elastic_ip_address == "203.0.113.8"
    assert server.subnet_cidr == "10.0.0.0/24"
    assert server.region_id == "r"
    # Verify the final production payload uses existing resource IDs directly.
    from app.provisioning import service
    monkeypatch.setattr(service, "_hydrate_private_network", AsyncMock())
    monkeypatch.setattr(service, "_resolve_or_create", AsyncMock(return_value=None))
    server.volumes = []
    server.instance_family = "gpu"  # no disk lookup needed in this focused test
    create = AsyncMock(return_value=({"id": "new-vm"}, 201))
    monkeypatch.setattr(service.cloud_v1, "create_resource", create)
    await _create_server("db", "user", "t", "p", body, server, None, "correlation")
    payload = create.await_args.args[5]
    assert payload["private_ip"] == {"type": "eni-key", "eni": "ip"}
    assert payload["elastic_ip"] == "eip" and payload["enable_elastic_ip"]
    assert all(request.args[3] == "GET" for request in call.await_args_list)
    assert create.await_args.args[4] == "servers"


@pytest.mark.asyncio
@pytest.mark.parametrize("path,field,value,status", [
    ("private-ips/ip", "subnet", "other", 422),
    ("private-ips/ip", "server", "other-vm", 409),
    ("private-ips/ip", "project", "other", 403),
    ("private-ips/ip", "ip_address", "10.1.0.8", 422),
    ("elastic-ips/eip", "region", "wrong-region", 422),
    ("elastic-ips/eip", "server", "other-vm", 409),
])
async def test_wrong_or_unavailable_ip_stops_before_vm_creation(api, path, field, value, status):
    rows, call = api
    rows[f"/legacy/api/infra/{path}/"][field] = value
    with pytest.raises(HTTPException) as error:
        await validate_allocated_network(deployment(), ("p", "t", None), "u", "db")
    assert error.value.status_code == status
    assert all(request.args[3] == "GET" for request in call.await_args_list)


@pytest.mark.asyncio
async def test_duplicate_ip_and_automatic_mode_are_rejected_without_api_calls(api):
    rows, call = api
    body = deployment()
    second = body.servers[0].model_copy(update={"name": "vm-2"})
    body.servers.append(second)
    with pytest.raises(HTTPException):
        await validate_allocated_network(body, ("p", "t", None), "u", "db")
    assert not call.await_count
    body = deployment()
    body.servers[0].elastic_ip_mode = "auto"
    with pytest.raises(HTTPException):
        await validate_allocated_network(body, ("p", "t", None), "u", "db")
    assert not call.await_count


@pytest.mark.asyncio
async def test_subnet_metadata_is_loaded_once_per_validation(api):
    rows, call = api
    body = deployment()
    second = body.servers[0].model_copy(update={"name": "vm-2", "eni_id": "ip2", "elastic_ip_mode": "none", "elastic_ip_id": None})
    body.servers.append(second)
    rows["/legacy/api/infra/private-ips/ip2/"] = {**rows["/legacy/api/infra/private-ips/ip/"], "id": "ip2", "ip_address": "10.0.0.9"}
    await validate_allocated_network(body, ("p", "t", None), "u", "db")
    assert sum(request.args[4] == "/legacy/api/infra/subnets/s/" for request in call.await_args_list) == 1


@pytest.mark.asyncio
async def test_network_is_rechecked_after_user_approval_before_queue(api, monkeypatch):
    rows, call = api
    monkeypatch.setattr(actions.get_settings(), "AGENT_SERVICE_BACKEND_KEY", "key")
    user = SimpleNamespace(role=Role.admin, cloud_api_access="full", permissions=[])
    request = Request({"type": "http", "headers": [(b"x-agent-service-key", b"key")]})
    body = deployment()
    await router.agent_validate_deployment(body, request, ("p", "t", None), user, "db")
    rows["/legacy/api/infra/private-ips/ip/"]["server"] = "another-vm"
    queue = AsyncMock()
    monkeypatch.setattr(router, "queue_deployment", queue)
    with pytest.raises(HTTPException) as unavailable:
        await router.agent_create_deployment(body, request, BackgroundTasks(), ("p", "t", None), user, "db")
    assert unavailable.value.status_code == 409
    assert not queue.await_count


@pytest.mark.asyncio
@pytest.mark.parametrize("address", [None, "10.0.0.8"])
async def test_agent_private_allocation_uses_only_selected_subnet_and_replays_result(monkeypatch, address):
    import asyncio
    monkeypatch.setattr(actions, "_private_allocations", {})
    monkeypatch.setattr(actions.get_settings(), "AGENT_SERVICE_BACKEND_KEY", "key")
    user = SimpleNamespace(id="u", role=Role.admin, cloud_api_access="full", permissions=[])
    request = Request({"type": "http", "headers": [(b"x-agent-service-key", b"key")]})
    async def read(*args, **kwargs):
        if args[4].endswith("/subnets/s/"):
            return {"id": "s", "project": "p", "cidr": "10.0.0.0/24"}, 200
        assert args[4] == "/legacy/api/infra/private-ips/"
        assert kwargs["params"]["subnet_id"] == "s"
        return {"results": [{"ip_address": "10.0.0.2"}], "count": 1}, 200
    call = AsyncMock(side_effect=read)
    monkeypatch.setattr(actions.cloud_v1, "call", call)
    listing = AsyncMock(return_value=({"results": [{"ip_address": "10.0.0.2"}]}, 200))
    monkeypatch.setattr(actions.cloud_v1, "list_resource", listing)
    async def create(*args, **kwargs):
        await asyncio.sleep(0.01)
        return {"id": "ip", "ip_address": args[5]["ip_address"], "project": "p", "server": None}, 201
    creating = AsyncMock(side_effect=create)
    monkeypatch.setattr(actions.cloud_v1, "create_resource", creating)
    monkeypatch.setattr(actions, "write_audit", AsyncMock())
    db = SimpleNamespace(add=Mock(), commit=AsyncMock())
    payload = actions.IpCreate(request_id=uuid4(), subnet_id="s", ip_address=address)
    first, replay = await asyncio.gather(*(actions.create_ip("private-ip", payload, request, ("p", "t", None), user, db) for _ in range(2)))
    assert first == replay and first["subnet_id"] == "s"
    assert creating.await_count == 1 and call.await_count == (1 if address else 2)
    assert call.await_args_list[0].args[4] == "/legacy/api/infra/subnets/s/"
    assert not listing.await_count
    assert first["ip_address"] not in {"10.0.0.0", "10.0.0.1", "10.0.0.2", "10.0.0.255"}
    cached = next(iter(actions._private_allocations.values()))
    assert not any("cidr" in value for value in cached.results.values())


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [409, 504])
async def test_allocation_pages_by_count_and_only_retries_definite_conflicts(monkeypatch, failure):
    monkeypatch.setattr(actions, "_private_allocations", {})
    async def read(*args, **kwargs):
        if args[4].endswith("/subnets/s/"):
            return {"project": "p", "cidr": "10.0.0.0/24"}, 200
        page = kwargs["params"]["page"]
        # Missing next URL must not omit the second page of occupied IPs.
        return {"results": [{"ip_address": f"10.0.0.{page + 1}"}], "count": 2, "next": None}, 200
    call = AsyncMock(side_effect=read)
    monkeypatch.setattr(actions.cloud_v1, "call", call)
    created_addresses = []
    async def create(*args, **kwargs):
        address = args[5]["ip_address"]
        assert address not in {"10.0.0.2", "10.0.0.3"}
        created_addresses.append(address)
        if len(created_addresses) == 1:
            raise HTTPException(failure, "conflict" if failure == 409 else "outcome unknown")
        return {"id": "ip", "ip_address": address, "project": "p", "server": None}, 201
    monkeypatch.setattr(actions.cloud_v1, "create_resource", create)
    monkeypatch.setattr(actions, "write_audit", AsyncMock())
    user = SimpleNamespace(id="u")
    db = SimpleNamespace(add=Mock(), commit=AsyncMock())
    payload = actions.IpCreate(request_id=uuid4(), subnet_id="s")
    if failure == 409:
        result = await actions.allocate_private_ip(payload, ("p", "t", None), user, db)
        assert result["ip_id"] == "ip" and len(set(created_addresses)) == 2
    else:
        for _ in range(2):
            with pytest.raises(HTTPException) as failed:
                await actions.allocate_private_ip(payload, ("p", "t", None), user, db)
            assert failed.value.status_code == 504
        assert len(created_addresses) == 1
    assert [request.kwargs["params"]["page"] for request in call.await_args_list if request.args[4].endswith("/private-ips/")] == [1, 2]
