from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.routers import vpc_peerings as api

ID = UUID("307eaba2-1c10-4906-956c-648a018a8c8e")
SOURCE = "7591aac3-e4d1-4168-a294-91b9b60a861c"
PEER = "14a657f1-aeaf-4673-9fd0-645eaf632c0d"
CONTEXT = ("current", "token", "approval")


@pytest.mark.parametrize("action", ["accept", "reject"])
async def test_pending_response_uses_current_project_and_documented_path(action):
    row = {"id": str(ID), "status": "pending", "requester_project": {"id": "other"}, "accepter_project": {"id": "current"}}
    with patch.object(api.cloud_v1, "list_resource", new=AsyncMock(return_value=({"results": [row]}, 200))), patch.object(api.cloud_v1, "call", new=AsyncMock(return_value=(None, 202))) as call, patch.object(api, "write_audit", new=AsyncMock()):
        result = await api.respond_peering(ID, action, CONTEXT, None, None, None)
    assert result.status_code == 202
    assert call.call_args.args[3:6] == ("POST", f"{api.UPSTREAM}{ID}/{action}/", "current")
    assert call.call_args.kwargs["approval"] == "approval"


@pytest.mark.parametrize("status,project,expected", [("active", "current", 409), ("pending", "unrelated", 403)])
async def test_mutations_reject_stale_status_or_wrong_project(status, project, expected):
    row = {"id": str(ID), "status": status, "requester_project": project, "accepter_project": "other"}
    with patch.object(api.cloud_v1, "list_resource", new=AsyncMock(return_value=({"results": [row]}, 200))), patch.object(api.cloud_v1, "call", new=AsyncMock()) as call:
        with pytest.raises(HTTPException) as error:
            await api.respond_peering(ID, "accept", CONTEXT, None, None, None)
        assert error.value.status_code == expected
        call.assert_not_awaited()


async def test_create_and_delete_forward_payload_and_handle_empty_responses():
    payload = api.PeeringCreate(requester_vpc=SOURCE, accepter_vpc=PEER, description="Test")
    with patch.object(api.cloud_v1, "list_resource", new=AsyncMock(return_value=({"results": [{"id": SOURCE}]}, 200))), patch.object(api.cloud_v1, "call", new=AsyncMock(return_value=({"id": str(ID)}, 201))) as call, patch.object(api, "write_audit", new=AsyncMock()):
        assert await api.create_peering(payload, CONTEXT, None, None, None) == {"id": str(ID)}
        assert call.call_args.kwargs["body"] == {"requester_vpc": SOURCE, "accepter_vpc": PEER, "description": "Test"}
    row = {"id": str(ID), "requester_project": "current", "accepter_project": "other"}
    with patch.object(api.cloud_v1, "list_resource", new=AsyncMock(return_value=({"results": [row]}, 200))), patch.object(api.cloud_v1, "call", new=AsyncMock(return_value=(None, 204))) as call, patch.object(api, "write_audit", new=AsyncMock()):
        assert (await api.delete_peering(ID, CONTEXT, None, None, None)).status_code == 204
        assert call.call_args.args[3:6] == ("DELETE", f"{api.UPSTREAM}{ID}/", "current")


async def test_create_rejects_unlisted_source_vpc():
    with patch.object(api.cloud_v1, "list_resource", new=AsyncMock(return_value=({"results": []}, 200))), patch.object(api.cloud_v1, "call", new=AsyncMock()) as call:
        with pytest.raises(HTTPException) as error:
            await api.create_peering(api.PeeringCreate(requester_vpc=SOURCE, accepter_vpc=PEER), CONTEXT, None, None, None)
        assert error.value.status_code == 422
        call.assert_not_awaited()


def test_create_rejects_identical_vpcs():
    with pytest.raises(ValidationError):
        api.PeeringCreate(requester_vpc=SOURCE, accepter_vpc=SOURCE)


async def test_peer_vpcs_use_accessible_target_project_without_changing_source():
    with patch.object(api, "list_projects", new=AsyncMock(return_value=[{"id": PEER}])), patch.object(api.cloud_v1, "list_resource", new=AsyncMock(return_value=({"results": [{"id": SOURCE}]}, 200))) as catalog:
        assert await api.list_vpcs(CONTEXT, None, None, UUID(PEER)) == [{"id": SOURCE}]
        assert catalog.call_args.args[3] == PEER
        assert catalog.call_args.kwargs["approval"] == "approval"
        assert CONTEXT[0] == "current"


async def test_peer_vpcs_deny_unmanaged_project_before_cloud_request():
    with patch.object(api, "list_projects", new=AsyncMock(return_value=[])), patch.object(api.cloud_v1, "list_resource", new=AsyncMock()) as catalog:
        with pytest.raises(HTTPException) as error:
            await api.list_vpcs(CONTEXT, None, None, UUID(PEER))
        assert error.value.status_code == 403
        catalog.assert_not_awaited()
