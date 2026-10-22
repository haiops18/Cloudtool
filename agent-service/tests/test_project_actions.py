import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app import audit, main
from app.gateway import Caller
from app.pending_actions import PendingActionBroker
from app.project_actions import PROJECT_TOOLS, project_action, project_tool_definitions


@pytest.mark.parametrize("tool,arguments", [
    ("create_private_ip", {"subnet_id": "s1", "ip_address": "10.0.0.8"}),
    ("create_elastic_ip", {"zone_id": "z1"}),
    ("attach_private_ip", {"server_id": "vm1", "ip_id": "ip1"}),
    ("attach_elastic_ip", {"server_id": "vm1", "ip_id": "eip1"}),
])
def test_project_tool_schema_roundtrip(tool, arguments):
    action = project_action(tool, arguments)
    assert action["type"] == PROJECT_TOOLS[tool][0]
    assert action["parameters"] == arguments
    assert tool in {t["name"] for t in project_tool_definitions()}
    with pytest.raises(ValidationError):
        project_action(tool, {**arguments, "project_id": "other"})


@pytest.mark.parametrize("tool,args,path", [
    ("create_private_ip", {"subnet_id": "s1"}, "private-ip/create"),
    ("create_elastic_ip", {"zone_id": "z1"}, "elastic-ip/create"),
    ("attach_private_ip", {"server_id": "vm1", "ip_id": "ip1"}, "private-ip/attach"),
    ("attach_elastic_ip", {"server_id": "vm1", "ip_id": "ip1"}, "elastic-ip/attach"),
])
def test_only_one_approved_decision_executes_and_returns_real_result(monkeypatch, tool, args, path):
    async def run():
        import httpx
        broker = PendingActionBroker()
        monkeypatch.setattr(main, "pending_actions", broker)
        monkeypatch.setattr(main, "record_api_action", lambda **kwargs: None)
        monkeypatch.setattr(audit, "record_api_action", lambda **kwargs: None)
        async def caller(request):
            return Caller("actor", "operator", "project", "token", "cookie", "csrf")
        monkeypatch.setattr(main.gateway, "caller", caller)
        requests = []
        class Client:
            def __init__(self, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def post(self, url, headers, json):
                requests.append((url, headers, json))
                await asyncio.sleep(0.01)
                return httpx.Response(200, json={"status": "completed", "ip_id": "real-ip", "ip_address": "10.0.0.8"})
        monkeypatch.setattr(httpx, "AsyncClient", Client)
        item = await broker.create("chat", "project", "actor", project_action(tool, args))
        assert not requests
        decisions = await asyncio.gather(
            main.decide_pending_action(item.id, {"decision": "approve"}, None),
            main.decide_pending_action(item.id, {"decision": "approve"}, None), return_exceptions=True)
        assert len(requests) == 1
        assert requests[0][0].endswith(path)
        assert requests[0][1]["X-Project-Id"] == "project"
        assert requests[0][2].get("request_id") == (item.id if tool.startswith("create") else None)
        assert any(isinstance(result, HTTPException) and result.status_code == 409 for result in decisions)
        assert (await broker.wait(item))["result"]["ip_id"] == "real-ip"
    asyncio.run(run())


def test_reject_expiry_and_wrong_project_never_write(monkeypatch):
    async def run():
        broker = PendingActionBroker()
        monkeypatch.setattr(audit, "record_api_action", lambda **kwargs: None)
        item = await broker.create("chat", "project", "actor", {"type": "private_ip.create"})
        with pytest.raises(HTTPException) as denied:
            await broker.claim(item.id, "other-project", "actor")
        assert denied.value.status_code == 404
        item.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        with pytest.raises(HTTPException) as expired:
            await broker.claim(item.id, "project", "actor")
        assert expired.value.status_code == 409
        assert (await broker.wait(item))["status"] == "rejected"
        monkeypatch.setattr(main, "pending_actions", broker)
        monkeypatch.setattr(main, "record_api_action", lambda **kwargs: None)
        async def caller(request):
            return Caller("actor", "operator", "project", "token", "cookie", "csrf")
        monkeypatch.setattr(main.gateway, "caller", caller)
        item = await broker.create("chat", "project", "actor", {"type": "elastic_ip.create"})
        assert await main.decide_pending_action(item.id, {"decision": "reject"}, None) == {"status": "rejected"}
        assert (await broker.wait(item))["status"] == "rejected"
    asyncio.run(run())


def test_failure_returns_upstream_detail_to_codex(monkeypatch):
    async def run():
        import httpx
        broker = PendingActionBroker()
        monkeypatch.setattr(main, "pending_actions", broker)
        monkeypatch.setattr(main, "record_api_action", lambda **kwargs: None)
        monkeypatch.setattr(audit, "record_api_action", lambda **kwargs: None)
        async def caller(request): return Caller("a", "operator", "p", "t", "c", "csrf")
        monkeypatch.setattr(main.gateway, "caller", caller)
        class Client:
            def __init__(self, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def post(self, *args, **kwargs):
                return httpx.Response(400, json={"error": {"upstream_detail": "No free IPs", "irrelevant": "large error"}})
        monkeypatch.setattr(httpx, "AsyncClient", Client)
        item = await broker.create("c", "p", "a", project_action("create_elastic_ip", {"zone_id": "z"}))
        result = await main.decide_pending_action(item.id, {"decision": "approve"}, None)
        assert result == {"status": "failed", "reason": "No free IPs"}
        assert await broker.wait(item) == result
    asyncio.run(run())


def test_approved_write_can_finish_after_approval_deadline(monkeypatch):
    async def run():
        broker = PendingActionBroker()
        monkeypatch.setattr(audit, "record_api_action", lambda **kwargs: None)
        item = await broker.create("c", "p", "a", {"type": "private_ip.create"}, timeout_seconds=0.05)
        await broker.claim(item.id, "p", "a")
        task = asyncio.create_task(broker.wait(item))
        await asyncio.sleep(0.12)
        assert not task.done()
        broker.resolve(item, {"status": "success", "result": {"ip_id": "real-ip"}})
        assert (await task)["status"] == "success"
        assert not broker._items
    asyncio.run(run())
