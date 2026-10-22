from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.api.routers.cloud import update_server_security_groups
from app.schemas.common import ServerSecurityGroupsUpdate


@pytest.mark.asyncio
async def test_update_uses_documented_endpoint_extended_timeout_and_audit():
    calls = AsyncMock(side_effect=[({'project': 'project', 'security_groups': ['old']}, 200), ({}, 202)])
    with patch('app.api.routers.cloud.cloud_v1.call', calls), \
         patch('app.api.routers.cloud.security_groups.all_resource_pages', new=AsyncMock(return_value=[{'id': 'new'}])), \
         patch('app.api.routers.cloud.write_audit', new=AsyncMock()) as audit:
        result = await update_server_security_groups('vm', ServerSecurityGroupsUpdate(security_groups=['new', 'new'], expected_security_groups=['old']), ('project', 'token', None), None, None, None)
        assert result['status'] == 'accepted'
        assert calls.call_args.args[3:6] == ('POST', '/legacy/api/infra/servers/vm/update-security-group/', 'project')
        assert calls.call_args.kwargs['body'] == {'security_groups': ['new']}
        assert calls.call_args.kwargs['timeout_seconds'] == 600
        assert calls.call_args_list[0].kwargs['timeout_seconds'] == 300
        audit.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize('detail,expected,code', [
    ({'project': 'other', 'security_groups': ['old']}, ['old'], 403),
    ({'project': 'project', 'security_groups': ['changed']}, ['old'], 409),
    ({'project': 'project'}, [], 502),
])
async def test_update_rejects_wrong_project_stale_or_missing_state(detail, expected, code):
    calls = AsyncMock(return_value=(detail, 200))
    with patch('app.api.routers.cloud.cloud_v1.call', calls):
        with pytest.raises(HTTPException) as exc:
            await update_server_security_groups('vm', ServerSecurityGroupsUpdate(security_groups=['new'], expected_security_groups=expected), ('project', 'token', None), None, None, None)
        assert exc.value.status_code == code
        assert calls.await_count == 1


@pytest.mark.asyncio
async def test_reconcile_matching_groups_does_not_resubmit_write():
    calls = AsyncMock(return_value=({'project': {'id': 'project'}, 'security_groups': [{'id': 'new'}]}, 200))
    with patch('app.api.routers.cloud.cloud_v1.call', calls):
        result = await update_server_security_groups('vm', ServerSecurityGroupsUpdate(security_groups=['new'], expected_security_groups=['old']), ('project', 'token', None), None, None, None)
        assert result['status'] == 'completed'
        assert calls.await_count == 1


@pytest.mark.asyncio
async def test_unknown_security_group_is_not_submitted():
    calls = AsyncMock(return_value=({'project': 'project', 'security_groups': ['old']}, 200))
    with patch('app.api.routers.cloud.cloud_v1.call', calls), \
         patch('app.api.routers.cloud.security_groups.all_resource_pages', new=AsyncMock(return_value=[])):
        with pytest.raises(HTTPException) as exc:
            await update_server_security_groups('vm', ServerSecurityGroupsUpdate(security_groups=['wrong-project-sg'], expected_security_groups=['old']), ('project', 'token', None), None, None, None)
        assert exc.value.status_code == 422
        assert calls.await_count == 1

@pytest.mark.asyncio
async def test_extended_validation_timeout_is_forwarded_to_every_list_page():
    from app.gateway.adapters import ViettelCloudV1
    adapter = ViettelCloudV1()
    adapter.call = AsyncMock(side_effect=[
        ({'results': [{'id': 'first'}], 'count': 2, 'next': 'page-2'}, 200),
        ({'results': [{'id': 'second'}], 'count': 2, 'next': None}, 200),
    ])
    data, _ = await adapter.list_resource(None, None, 'token', 'project', 'security-groups', 1, 200, timeout_seconds=300)
    assert len(data['results']) == 2
    assert adapter.call.await_count == 2
    assert all(call.kwargs['timeout_seconds'] == 300 for call in adapter.call.call_args_list)
