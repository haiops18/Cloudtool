from unittest.mock import AsyncMock, patch

import pytest

from app.gateway.adapters import cloud_v1
from app.gateway.client import CLOUD_AUDIT_ACTIONS


@pytest.mark.asyncio
async def test_current_cloud_user_uses_selected_project_and_is_audited():
    payload = {"id": "user-1", "username": "cloud-user"}
    with patch(
        "app.gateway.adapters.gateway.request",
        new=AsyncMock(return_value=(payload, 200)),
    ) as request:
        result = await cloud_v1.current_user(
            None,
            None,
            "Token private-token",
            "project-1",
        )

    assert result == (payload, 200)
    request.assert_awaited_once_with(
        None,
        None,
        "Token private-token",
        "GET",
        "/legacy/api/tenant/users/current-user/",
        project_id="project-1",
        params=None,
        body=None,
        approval_id=None,
        request_timeout=None,
    )
    assert CLOUD_AUDIT_ACTIONS["/legacy/api/tenant/users/current-user/"] == (
        "cloud.user.current.view",
        "cloud_user",
    )
