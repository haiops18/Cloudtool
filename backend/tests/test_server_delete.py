from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from app.api.routers.cloud import delete_servers
from app.schemas.common import ServerDeleteBatch

@asynccontextmanager
async def session():
    yield None


@pytest.mark.asyncio
async def test_deletion_preserves_attachment_selection_project_and_extended_timeout():
    calls = AsyncMock(side_effect=[({"project": {"id": "project"}, "name": "VM"}, 200), ({}, 202)])
    with patch("app.api.routers.cloud.SessionFactory", session), patch("app.api.routers.cloud.cloud_v1.call", calls), patch("app.api.routers.cloud.write_audit", new=AsyncMock()) as audit:
        result = await delete_servers(ServerDeleteBatch(items=[{"server_id": "vm", "volumes": ["selected-volume"], "eips": [], "private_ips": ["selected-ip"]}]), ("project", "token", None), None, None, None)
    assert result["items"][0]["status"] == "accepted"
    assert calls.call_args.args[3:6] == ("POST", "/legacy/api/infra/servers/vm/delete/", "project")
    assert calls.call_args.kwargs["body"] == {"volumes": ["selected-volume"], "eips": [], "private_ips": ["selected-ip"]}
    assert calls.call_args.kwargs["timeout_seconds"] == 600
    assert calls.call_args_list[0].kwargs["timeout_seconds"] == 300
    audit.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("code,expected", [(400, "failed"), (504, "unconfirmed")])
async def test_delete_does_not_retry_uncertain_write(code, expected):
    calls = AsyncMock(side_effect=[({"project": "project"}, 200), HTTPException(code, {"upstream_detail": "Cloud error"})])
    with patch("app.api.routers.cloud.SessionFactory", session), patch("app.api.routers.cloud.cloud_v1.call", calls), patch("app.api.routers.cloud.write_audit", new=AsyncMock()):
        result = await delete_servers(ServerDeleteBatch(items=[{"server_id": "vm"}]), ("project", "token", None), None, None, None)
    assert result["items"][0]["status"] == expected
    assert calls.await_count == 2
    assert result["items"][0]["error_detail"] == {"upstream_detail": "Cloud error"}


@pytest.mark.asyncio
async def test_delete_rejects_other_project_without_write():
    calls = AsyncMock(return_value=({"project": "other"}, 200))
    with patch("app.api.routers.cloud.SessionFactory", session), patch("app.api.routers.cloud.cloud_v1.call", calls), patch("app.api.routers.cloud.write_audit", new=AsyncMock()):
        result = await delete_servers(ServerDeleteBatch(items=[{"server_id": "vm"}]), ("project", "token", None), None, None, None)
    assert result["items"][0]["status"] == "failed"
    assert calls.await_count == 1
