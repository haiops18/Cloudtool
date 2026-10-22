from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.api.routers.cloud import server_detail


@pytest.mark.asyncio
async def test_detail_resolves_subnet_and_vips_per_ip_with_paginated_catalogs():
    detail = {"project": "project", "user_data": "#cloud-config\n" + "a" * 400,
        "private_ip": [{"id": "private1", "ip_address": "10.0.0.2", "subnet": "subnet"},
                       {"id": "private2", "ip_address": "10.0.0.3", "subnet": "subnet"}],
        "elastic_ip": [{"id": "elastic", "ip_address": "171.1.1.1", "allowed_vips": ["evip", "evip"]}]}
    requests = []

    async def catalog(db, user, token, project, resource, page, page_size, **kwargs):
        assert project == "project"
        requests.append((resource, page))
        if resource == "subnets":
            rows = [{"id": "subnet", "display_name": "Production", "cidr": "10.0.0.0/24"}]
        elif resource == "private-ips":
            assert kwargs['params'] == {'subnet_id': 'subnet', '_include_all_private_ips': 'true'}
            rows = [{"id": "private1", "vips": ["pvip", {"ip_address": "10.0.0.5"}]},
                    {"id": "private2", "allowed_vips": ["pvip"]},
                    {"id": "pvip", "ip_address": "10.0.0.4"}]
        else:
            rows = [{"id": "elastic"}] if page == 1 else [{"id": "evip", "ip_address": "171.1.1.2"}]
        return {'results': rows, 'next': 'next' if resource == 'elastic-ips' and page == 1 else None}, 200

    with patch('app.api.routers.cloud.cloud_v1.call', new=AsyncMock(return_value=(detail, 200))), \
         patch('app.api.routers.cloud.cloud_v1.list_resource', new=catalog):
        result = await server_detail('vm', ('project', 'token', None), None, None, include_network_details=True)
    assert result['user_data'] == detail['user_data']
    assert result['network_detail_errors'] == []
    private = result['network_details']['private_ips']
    assert private[0]['subnet']['cidr'] == '10.0.0.0/24'
    assert private[0]['subnet']['display_name'] == 'Production'
    assert private[0]['vip_ips'] == ['10.0.0.4', '10.0.0.5']
    assert private[1]['vip_ips'] == ['10.0.0.4']
    assert result['network_details']['elastic_ips'][0]['vip_ips'] == ['171.1.1.2']
    assert requests == [('subnets', 1), ('private-ips', 1), ('elastic-ips', 1), ('elastic-ips', 2)]


@pytest.mark.asyncio
async def test_network_lookup_failure_keeps_vm_and_userdata_visible():
    detail = {'project': 'project', 'userData': 'complete data',
              'elastic_ip': [{'id': 'elastic', 'ip_address': '171.1.1.1', 'allowed_vips': ['unresolved-id']}]}
    with patch('app.api.routers.cloud.cloud_v1.call', new=AsyncMock(return_value=(detail, 200))), \
         patch('app.api.routers.cloud.cloud_v1.list_resource', new=AsyncMock(side_effect=HTTPException(502, 'Unavailable'))):
        result = await server_detail('vm', ('project', 'token', None), None, None, include_network_details=True)
    assert result['userData'] == 'complete data'
    assert result['network_detail_errors']
    assert result['network_details']['elastic_ips'][0]['ip_address'] == '171.1.1.1'
    assert result['network_details']['elastic_ips'][0]['vip_ips'] == []


@pytest.mark.asyncio
async def test_existing_detail_requests_do_not_load_network_catalogs_and_check_project_first():
    with patch('app.api.routers.cloud.cloud_v1.call', new=AsyncMock(return_value=({'project': 'project'}, 200))), \
         patch('app.api.routers.cloud.cloud_v1.list_resource', new=AsyncMock()) as catalog:
        assert await server_detail('vm', ('project', 'token', None), None, None) == {'project': 'project'}
        with pytest.raises(HTTPException) as error:
            await server_detail('vm', ('another-project', 'token', None), None, None, include_network_details=True)
        assert error.value.status_code == 403
        catalog.assert_not_awaited()


@pytest.mark.asyncio
async def test_private_ip_id_only_resolves_subnet_and_embedded_vip_address():
    detail = {'project': 'project', 'private_ip': ['private1']}
    async def catalog(*args, **kwargs):
        rows = [{'id': 'subnet', 'name': 'Shared subnet', 'cidr': '10.0.0.0/24'}] if args[4] == 'subnets' else [
            {'id': 'private1', 'ip_address': '10.0.0.2', 'subnet': 'subnet', 'vips': ['10.0.0.4']}]
        return {'results': rows, 'next': None}, 200
    with patch('app.api.routers.cloud.cloud_v1.call', new=AsyncMock(return_value=(detail, 200))), \
         patch('app.api.routers.cloud.cloud_v1.list_resource', new=catalog):
        result = await server_detail('vm', ('project', 'token', None), None, None, include_network_details=True)
    row = result['network_details']['private_ips'][0]
    assert row['ip_address'] == '10.0.0.2'
    assert row['subnet']['cidr'] == '10.0.0.0/24'
    assert row['vip_ips'] == ['10.0.0.4']


@pytest.mark.asyncio
async def test_all_servers_detail_reuses_original_handler_with_vm_project_context():
    from app.api.routers.cloud import all_server_inventory_server_detail
    detail = {'id': 'vm', 'project': 'vm-project', 'userData': 'a' * 400,
              'network_details': {'private_ips': [], 'elastic_ips': []}}
    with patch('app.api.routers.cloud._accessible_projects', new=AsyncMock(return_value=[{'id': 'vm-project'}])), \
         patch('app.api.routers.cloud.server_detail', new=AsyncMock(return_value=detail)) as shared, \
         patch('app.api.routers.cloud._inventory_reference_maps', new=AsyncMock(return_value={})):
        result = await all_server_inventory_server_detail('vm-project', 'vm', ('token', None), None, None, include_network_details=True)
        shared.assert_awaited_once_with('vm', ('vm-project', 'token', None), None, None, include_network_details=True)
        assert result['item']['network_details'] == detail['network_details']
        assert result['item']['user_data'] == 'a' * 400
        with pytest.raises(HTTPException) as error:
            await all_server_inventory_server_detail('denied-project', 'vm', ('token', None), None, None, include_network_details=True)
        assert error.value.status_code == 403
        assert shared.await_count == 1
