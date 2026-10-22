import ipaddress
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.routers import manual_ip_allocations as api
from app.models import Role


@pytest.fixture(autouse=True)
def clear_batches():
    api._batches.clear()


def batch(**overrides):
    return api.ManualIpBatch(request_id=uuid4(), items=[api.ManualIpItem(
        server_draft_id="vm-1", server_name="app-1", subnet_id="subnet", region_id="stale-region", zone_id="zone",
        create_private=True, create_elastic=True, **overrides,
    )])


def actor():
    return SimpleNamespace(id="user", role=Role.admin, cloud_api_access="full")


def db_mock():
    return SimpleNamespace(add=lambda _: None, commit=AsyncMock())


def test_random_selection_uses_only_free_hosts_and_scales_to_large_subnets(monkeypatch):
    monkeypatch.setattr(api.secrets, "randbelow", lambda count: count - 1)
    network = ipaddress.ip_network("10.0.0.0/29")
    taken = {int(ipaddress.ip_address("10.0.0.2")), int(ipaddress.ip_address("10.0.0.6"))}
    assert api.random_free_address(network, taken) == "10.0.0.5"
    assert api.random_free_address(ipaddress.ip_network("10.0.0.0/8"), set()) == "10.255.255.254"
    with pytest.raises(ValueError, match="No unused"):
        api.random_free_address(ipaddress.ip_network("10.0.0.0/30"), {int(ipaddress.ip_address("10.0.0.2"))})


async def test_allocations_use_current_project_and_replay_returns_same_resources(monkeypatch):
    async def catalog(db, user, token, project, resource, *args, **kwargs):
        assert project == "project"
        if resource == "subnets":
            return {"results": [{"id": "subnet", "cidr": "10.0.0.0/29"}]}, 200
        assert kwargs["params"]["_include_all_private_ips"] == "true"
        return {"results": [{"ip_address": "10.0.0.2", "server": None}]}, 200

    async def call(db, user, token, method, path, project, **kwargs):
        if method == "GET":
            return {"results": [{"id": "zone", "region": {"id": "region"}}]}, 200
        assert method == "POST" and path == "/legacy/api/infra/elastic-ips/"
        assert project == "project"
        assert kwargs["body"] == {"region": "region", "enable_ipv6": False}
        return {"id": "eip", "ip_address": "203.0.113.42", "project": {"id": "project"}}, 201

    created = []

    async def create(db, user, token, project, resource, body, approval):
        if resource == "elastic-ips":
            return await api.cloud_v1.call(db, user, token, "POST", "/legacy/api/infra/elastic-ips/", project, body=body, approval=approval)
        assert body["ip_address"] != "10.0.0.2"
        created.append(body["ip_address"])
        return {"id": "pip", "ip_address": body["ip_address"], "description": "", "server": None}, 201

    monkeypatch.setattr(api.cloud_v1, "list_resource", catalog)
    call_mock = AsyncMock(side_effect=call)
    monkeypatch.setattr(api.cloud_v1, "call", call_mock)
    monkeypatch.setattr(api.cloud_v1, "create_resource", create)
    audit = AsyncMock()
    monkeypatch.setattr(api, "write_audit", audit)
    request = batch()
    result = await api.create_manual_ips(request, ("project", "token", None), actor(), None, db_mock())
    replay = await api.create_manual_ips(request, ("project", "token", None), actor(), None, db_mock())
    assert result == replay
    assert len(created) == 1
    assert sum(call.args[3] == "POST" for call in call_mock.call_args_list) == 1
    assert result["items"][0]["elastic"]["ip_address"] == "203.0.113.42"
    elastic_audits = [call for call in audit.call_args_list if call.args[2] == "elastic_ip.create"]
    assert len(elastic_audits) == 1
    assert elastic_audits[0].args[3] == "success"
    assert elastic_audits[0].kwargs["metadata"]["region"] == "region"
    assert elastic_audits[0].kwargs["target_id"] == "eip"


async def test_private_collision_retries_a_different_address_and_elastic_failure_is_independent(monkeypatch):
    monkeypatch.setattr(api.cloud_v1, "list_resource", AsyncMock(side_effect=[
        ({"results": [{"id": "subnet", "cidr": "10.0.0.0/29"}]}, 200),
        ({"results": []}, 200),
    ]))
    monkeypatch.setattr(api.secrets, "randbelow", lambda count: 0)
    monkeypatch.setattr(api.cloud_v1, "call", AsyncMock(side_effect=[({"results": [{"id": "zone", "region": "region"}]}, 200), HTTPException(403, "Quota denied")]))
    monkeypatch.setattr(api.cloud_v1, "create_elastic_ip", AsyncMock(side_effect=HTTPException(403, {"message": "Cloud API request failed", "upstream_detail": "Quota denied"})))
    create = AsyncMock(side_effect=[HTTPException(409, "Already exists"), ({"id": "pip", "ip_address": "10.0.0.3", "server": None}, 201)])
    monkeypatch.setattr(api.cloud_v1, "create_resource", create)
    monkeypatch.setattr(api, "write_audit", AsyncMock())
    result = await api.create_manual_ips(batch(), ("project", "token", None), actor(), None, db_mock())
    assert result["items"][0]["private"]["status"] == "completed"
    assert result["items"][0]["elastic"]["status"] == "failed"
    assert result["items"][0]["elastic"]["error"] == "Quota denied"
    assert [call.args[5]["ip_address"] for call in create.call_args_list] == ["10.0.0.2", "10.0.0.3"]


async def test_access_denial_happens_before_any_cloud_call(monkeypatch):
    catalog = AsyncMock()
    monkeypatch.setattr(api.cloud_v1, "list_resource", catalog)
    user = actor()
    user.cloud_api_access = "read"
    with pytest.raises(HTTPException) as error:
        await api.create_manual_ips(batch(), ("project", "token", None), user, None, db_mock())
    assert error.value.status_code == 403
    catalog.assert_not_awaited()


def test_payload_requires_fields_and_rejects_duplicate_drafts():
    with pytest.raises(ValidationError):
        api.ManualIpItem(server_draft_id="draft", server_name="VM", create_private=True)
    item = api.ManualIpItem(server_draft_id="draft", server_name="VM", create_elastic=True, zone_id="zone")
    with pytest.raises(ValidationError):
        api.ManualIpBatch(request_id=uuid4(), items=[item, item])


async def test_unknown_vm_zone_cannot_allocate_in_client_supplied_region(monkeypatch):
    request = api.ManualIpBatch(request_id=uuid4(), items=[api.ManualIpItem(
        server_draft_id="vm", server_name="VM", zone_id="unknown", region_id="region", create_elastic=True,
    )])
    monkeypatch.setattr(api.cloud_v1, "call", AsyncMock(return_value=({"results": [{"id": "valid-zone", "region": {"id": "region"}}]}, 200)))
    create = AsyncMock()
    audit = AsyncMock()
    monkeypatch.setattr(api.cloud_v1, "create_elastic_ip", create)
    monkeypatch.setattr(api, "write_audit", audit)
    result = await api.create_manual_ips(request, ("project", "token", None), actor(), None, db_mock())
    assert result["items"][0]["elastic"]["status"] == "failed"
    create.assert_not_awaited()
    assert audit.call_args_list[0].args[2:4] == ("elastic_ip.create", "failed")
