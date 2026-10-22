from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError
from fastapi import HTTPException

from app.api.routers.cloud import resize_servers
from app.schemas.common import ResizeBatch


def payload(live=True, server_type="basic"):
    return ResizeBatch(items=[{"server_id": "vm", "specs": {"server_type": server_type, "kind": "custom", "ram": 6, "vcpus": 2}, "live_resize": live}])


@pytest.mark.asyncio
@pytest.mark.parametrize("state,live,server_type", [("running", True, "basic"), ("shutdown", False, "gpu"), ("shutoff", False, "basic")])
async def test_resize_sends_new_contract_and_accepts_both_modes(state, live, server_type):
    calls = AsyncMock(side_effect=[({"project": {"id": "project"}, "name": "VM", "server_type": server_type, "power_state": state}, 200), ({}, 202)])
    with patch("app.api.routers.cloud.cloud_v1.call", calls), patch("app.api.routers.cloud.write_audit", new=AsyncMock()) as audit:
        result = await resize_servers(payload(live, server_type), ("project", "token", None), None, None, None)
    assert result["items"][0]["status"] == "accepted"
    assert calls.call_args.args[3:6] == ("POST", "/legacy/api/infra/servers/vm/resize/", "project")
    assert calls.call_args.kwargs["body"] == {"specs": {"server_type": server_type, "kind": "custom", "ram": 6, "vcpus": 2}, "live_resize": live}
    assert calls.call_args.kwargs["timeout_seconds"] == 600
    audit.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("detail", [
    {"project": "other", "power_state": "running", "server_type": "basic"},
    {"project": "project", "power_state": "shutdown", "server_type": "basic"},
    {"project": "project", "power_state": "paused", "server_type": "basic"},
    {"project": "project", "power_state": "running", "server_type": "gpu"},
])
async def test_resize_rejects_wrong_project_changed_state_and_type(detail):
    calls = AsyncMock(return_value=(detail, 200))
    with patch("app.api.routers.cloud.cloud_v1.call", calls), patch("app.api.routers.cloud.write_audit", new=AsyncMock()):
        result = await resize_servers(payload(), ("project", "token", None), None, None, None)
    assert result["items"][0]["status"] == "failed"
    assert calls.await_count == 1


@pytest.mark.parametrize("field,value", [("ram", 0), ("ram", float("inf")), ("vcpus", 1.5), ("vcpus", 0), ("server_type", "unknown")])
def test_resize_validates_custom_specs(field, value):
    data = payload().model_dump()
    data["items"][0]["specs"][field] = value
    with pytest.raises(ValidationError):
        ResizeBatch(**data)


@pytest.mark.asyncio
@pytest.mark.parametrize("family", ["basic", "gpu"])
async def test_resize_uses_flavor_family_instead_of_billing_server_type(family):
    calls = AsyncMock(side_effect=[({"project": "project", "server_type": "on_demand", "power_state": "running", "flavor": {"family": family, "ram": 4, "vcpus": 2}}, 200), ({}, 202)])
    with patch("app.api.routers.cloud.cloud_v1.call", calls), patch("app.api.routers.cloud.write_audit", new=AsyncMock()):
        result = await resize_servers(payload(True, family), ("project", "token", None), None, None, None)
    assert result["items"][0]["status"] == "accepted"
    assert calls.call_args.kwargs["body"]["specs"]["server_type"] == family


@pytest.mark.asyncio
async def test_resize_keeps_structured_upstream_error_for_ui():
    detail = {"message": "Gateway failure", "upstream_detail": "Not enough memory"}
    calls = AsyncMock(side_effect=[({"project": "project", "server_type": "basic", "power_state": "running"}, 200), HTTPException(400, detail)])
    with patch("app.api.routers.cloud.cloud_v1.call", calls), patch("app.api.routers.cloud.write_audit", new=AsyncMock()):
        result = await resize_servers(payload(), ("project", "token", None), None, None, None)
    assert result["items"][0]["error"] == detail
