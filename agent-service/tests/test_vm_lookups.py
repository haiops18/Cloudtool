import asyncio
import json
from pathlib import Path

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from app import main, mcp_server
from app.gateway import Caller, CloudToolGateway
from app.vm_lookups import VmLookup, lookup, lookup_many


CALLER = Caller("operator@example.test", "operator", "project-a", "token", "cookie", "csrf")


def test_invalid_filters_and_project_override_are_rejected():
    for payload in ({"resource": "flavors"}, {"resource": "security_groups"},
                    {"resource": "images", "zone": "z"},
                    {"resource": "images", "project_id": "other"},
                    {"resource": "../servers"}, {"resource": "zones", "page_size": 101}):
        with pytest.raises(ValidationError):
            VmLookup.model_validate(payload)


def test_batch_is_concurrent_bounded_and_preserves_partial_results(monkeypatch):
    active = peak = 0
    async def fake_get(self, client, caller, path, params=None):
        nonlocal active, peak
        assert caller.project_id == "project-a"
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0.01)
            if path.endswith("server-images"):
                raise HTTPException(403, "sensitive upstream body")
            return {"items": [{"id": params["zone"], "zone": params["zone"]}], "total": 1}
        finally:
            active -= 1
    monkeypatch.setattr(CloudToolGateway, "_get", fake_get)
    requests = [VmLookup(resource="flavors", zone=f"z-{i}") for i in range(8)]
    requests.insert(2, VmLookup(resource="images"))
    result = asyncio.run(lookup_many(CloudToolGateway(), CALLER, requests))
    assert peak == 4
    assert [r["index"] for r in result["results"]] == list(range(9))
    assert result["results"][2]["error"]["status"] == 403
    assert result["results"][3]["result"]["items"][0]["id"] == "z-2"
    assert "sensitive" not in json.dumps(result)


def test_pagination_filters_and_safe_keypair_metadata(monkeypatch):
    calls = []
    async def fake_get(self, client, caller, path, params=None):
        calls.append((path, params))
        return {"items": [{"id": "key-1", "name": "deploy", "private_key": "never-return"}], "total": 3}
    monkeypatch.setattr(CloudToolGateway, "_get", fake_get)
    result = asyncio.run(lookup(None, CloudToolGateway(), CALLER,
                              VmLookup(resource="keypairs", q="deploy", page_size=1)))
    assert calls == [("/cloud/server-keypairs", {"page": 1, "page_size": 1, "q": "deploy"})]
    assert result["next_page"] == 2
    assert result["items"] == [{"id": "key-1", "name": "deploy"}]


def test_regions_use_live_catalog_and_templates_local_pagination(monkeypatch):
    async def fake_get(self, client, caller, path, params=None):
        if path.endswith("server-regions"):
            assert params == {"page": 2, "page_size": 1}
            return {"items": [{"id": "r2", "region_name": "two"}], "total": 2}
        return {"items": [{"id": "t1", "name": "one", "content": "secret-script"},
                          {"id": "t2", "is_active": False}]}
    monkeypatch.setattr(CloudToolGateway, "_get", fake_get)
    regions = asyncio.run(lookup(None, CloudToolGateway(), CALLER, VmLookup(resource="regions", page_size=1, page=2)))
    assert regions["items"] == [{"id": "r2", "region_name": "two"}]
    assert regions["total"] == 2 and not regions["has_more"]
    templates = asyncio.run(lookup(None, CloudToolGateway(), CALLER, VmLookup(resource="cloud_init_templates")))
    assert templates["items"] == [{"id": "t1", "name": "one"}]


def test_http_api_authentication_and_batch_limits(monkeypatch):
    async def denied(request):
        raise HTTPException(401, "login required")
    monkeypatch.setattr(main.gateway, "caller", denied)
    client = TestClient(main.app, base_url="http://localhost")
    assert client.get("/api/v1/vm-creation/options?resource=zones").status_code == 401
    async def caller(request):
        return CALLER
    async def fake_get(self, client, caller, path, params=None):
        return {"items": [{"id": "z1", "region": "r1"}]}
    monkeypatch.setattr(main.gateway, "caller", caller)
    monkeypatch.setattr(CloudToolGateway, "_get", fake_get)
    assert client.get("/api/v1/vm-creation/options?resource=flavors").status_code == 422
    assert client.get("/api/v1/vm-creation/options?resource=zones&project_id=other").status_code == 422
    response = client.get("/api/v1/vm-creation/options?resource=zones")
    assert response.status_code == 200 and response.json()["project_id"] == "project-a"
    route = "/api/v1/vm-creation/options/batch"
    assert client.post(route, json={"requests": []}).status_code == 422
    assert client.post(route, json={"requests": [{"resource": "zones"}] * 17}).status_code == 422
    assert client.post(route, json={"requests": [{"resource": "zones"}]}).json()["results"][0]["ok"]


def test_mcp_can_repeat_discovery_calls_in_same_conversation(monkeypatch):
    monkeypatch.setattr(mcp_server, "_caller", lambda: CALLER)
    async def fake_get(self, client, caller, path, params=None):
        return {"items": [{"id": "z1", "region": "r1"}], "total": 1}
    monkeypatch.setattr(CloudToolGateway, "_get", fake_get)
    async def run():
        first = json.loads(await mcp_server._call_tool("batch_vm_creation_options", {"requests": [{"resource": "zones"}]}))
        zone = first["results"][0]["result"]["items"][0]["id"]
        return json.loads(await mcp_server._call_tool("get_vm_creation_options", {"resource": "flavors", "zone": zone}))
    assert asyncio.run(run())["filters"]["zone"] == "z1"


def test_lookup_guide_is_installed_and_refreshed_in_workspace(monkeypatch, tmp_path):
    from app.project_workspace import prepare_project_workspace
    monkeypatch.setattr(main.settings, "CODEX_PROJECT_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setattr(main.settings, "CODEX_SOURCE_ROOT", str(Path(__file__).resolve().parents[2]))
    workspace = prepare_project_workspace("project-a")
    guide = Path(workspace.path) / "api-docs" / "vm-creation-lookups.md"
    assert "batch_vm_creation_options" in guide.read_text(encoding="utf-8")
    guide.write_text("outdated", encoding="utf-8")
    prepare_project_workspace("project-a")
    assert "Multiple APIs and multiple rounds" in guide.read_text(encoding="utf-8")


def test_detail_and_contract_requests_are_allowlisted(monkeypatch):
    calls = []
    async def fake_get(self, client, caller, path, params=None):
        calls.append((path, params))
        return {"variables": ["custom_field"]} if "planning-options" in path else {"schema": {"required": ["servers"]}}
    monkeypatch.setattr(CloudToolGateway, "_get", fake_get)
    result = asyncio.run(lookup(None, CloudToolGateway(), CALLER, VmLookup(resource="cloud_init_template", template_id="t1")))
    assert result["data"]["variables"] == ["custom_field"]
    result = asyncio.run(lookup(None, CloudToolGateway(), CALLER, VmLookup(resource="deployment_schema")))
    assert result["data"]["schema"]["required"] == ["servers"]
    assert calls == [("/cloud/cloud-init-templates/t1/planning-options", None), ("/provisioning/deployment-schema", None)]
    with pytest.raises(ValidationError):
        VmLookup(resource="cloud_init_template", template_id="../../other")


def test_deployment_status_returns_real_server_ids_without_payloads(monkeypatch):
    async def fake_get(self, client, caller, path, params=None):
        assert path == "/provisioning/deployments/d1"
        return {"id": "d1", "status": "completed", "servers": [{"server_name": "vm", "server_id": "real-vm",
                "status": "completed", "request": {"large": "payload"}, "result": {"password": "secret"}}]}
    monkeypatch.setattr(CloudToolGateway, "_get", fake_get)
    result = asyncio.run(lookup(None, CloudToolGateway(), CALLER, VmLookup(resource="deployment_status", deployment_id="d1")))
    assert result["data"]["servers"][0]["server_id"] == "real-vm"
    assert "payload" not in str(result) and "secret" not in str(result)
