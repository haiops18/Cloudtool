from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from app.api.routers.cloud import (
    _elastic_vip_ips,
    all_server_inventory,
    refresh_all_server_inventory_servers,
    sync_all_server_inventory_project,
)
from app.db.init_db import migrate_elastic_vip_inventory_column
from app.models.entities import AllServerInventorySnapshot


def test_resolves_only_addresses_deduplicates_and_supports_object_vips():
    catalog = {'vip': {'id': 'vip', 'ip_address': '171.253.170.168'},
               'parent': {'allowed_vips': ['vip']}}
    snapshot = {'elastic_ip': [{'id': 'parent', 'allowed_vips': ['vip', 'missing', 'vip', {'ip_address': '171.253.170.169'}]}, 'parent']}
    assert _elastic_vip_ips(snapshot, catalog) == ['171.253.170.168', '171.253.170.169']
    assert _elastic_vip_ips({'elastic_ip': []}, catalog) == []


@pytest.mark.asyncio
async def test_sync_and_refresh_reuse_paginated_project_ips_and_store_searchable_vips():
    engine = create_engine('sqlite://', execution_options={'schema_translate_map': {'telemetry': None}})
    AllServerInventorySnapshot.__table__.create(engine)
    servers = [{'id': f'vm{i}', 'name': f'VM{i}', 'elastic_ip': [{'id': 'parent', 'ip_address': '171.253.170.167', 'allowed_vips': ['vip']}]} for i in range(2)]
    catalog_calls = []
    async def upstream(*args, **kwargs):
        url = args[4]
        assert args[5] == 'project'
        if url.endswith('/elastic-ips/'):
            page = kwargs['params']['page']
            catalog_calls.append(page)
            return ({'results': [{'id': 'parent', 'ip_address': '171.253.170.167', 'allowed_vips': ['vip']}] if page == 1 else [{'id': 'vip', 'ip_address': '171.253.170.168'}], 'next': 'page2' if page == 1 else None}, 200)
        return (servers[0] if 'vm0' in url else servers[1], 200)
    with Session(engine) as session:
        db = SimpleNamespace(
            scalars=AsyncMock(side_effect=session.scalars), scalar=AsyncMock(side_effect=session.scalar),
            commit=AsyncMock(side_effect=session.commit), add=session.add,
        )
        with patch('app.api.routers.cloud._accessible_projects', new=AsyncMock(return_value=[{'id': 'project', 'name': 'Project', 'display_name': 'Project'}])), \
             patch('app.api.routers.cloud._all_project_server_rows', new=AsyncMock(return_value=servers)), \
             patch('app.api.routers.cloud.get_zones', new=AsyncMock(return_value=[])), \
             patch('app.api.routers.cloud.write_audit', new=AsyncMock()), \
             patch('app.api.routers.cloud.cloud_v1.call', new=upstream):
            result = await sync_all_server_inventory_project({'project_id': 'project'}, ('token', None), None, None, db)
            assert result['servers'] == 2
            assert catalog_calls == [1, 2]
            stored = session.scalars(select(AllServerInventorySnapshot)).all()
            assert all(row.elastic_vip_ip == ['171.253.170.168'] for row in stored)
            await refresh_all_server_inventory_servers({'items': [{'project_id': 'project', 'server_id': f'vm{i}'} for i in range(2)]}, ('token', None), None, None, db)
            assert catalog_calls == [1, 2, 1, 2]
        for filters in [
            {'elastic_vip_ip': '170.168'},
            {'elastic_ip': '170.168'},
            {'batch_fields': 'elastic_ip', 'batch_values': '171.253.170.168', 'ip_match': 'exact'},
            {'q': '171.253.170.168'},
            {'batch_fields': 'elastic_vip_ip', 'batch_values': '171.253.170.168', 'ip_match': 'exact'},
            {'sql_query': "SELECT * FROM all_server_inventory_snapshots WHERE elastic_vip_ip LIKE '%170.168%'"},
        ]:
            result = await all_server_inventory(('token', None), None, db, **filters)
            assert result['total'] == 2
            assert all(row['elastic_vip_ip'] == ['171.253.170.168'] for row in result['items'])
        result = await all_server_inventory(('token', None), None, db, batch_fields='elastic_vip_ip', batch_values='171.253.170.16', ip_match='exact')
        assert result['total'] == 0
    engine.dispose()


@pytest.mark.parametrize('schema', [None, 'telemetry'])
def test_column_migration_preserves_rows_and_is_idempotent(schema):
    engine = create_engine('sqlite://')
    with engine.begin() as connection:
        if schema:
            connection.execute(text("ATTACH DATABASE ':memory:' AS telemetry"))
        table = 'telemetry.all_server_inventory_snapshots' if schema else 'all_server_inventory_snapshots'
        connection.execute(text(f'CREATE TABLE {table} (id TEXT PRIMARY KEY, elastic_ip JSON)'))
        connection.execute(text(f"INSERT INTO {table} VALUES ('vm', '[\"171.253.170.167\"]')"))
        migrate_elastic_vip_inventory_column(connection)
        migrate_elastic_vip_inventory_column(connection)
        row = connection.execute(text(f'SELECT id, elastic_ip, elastic_vip_ip FROM {table}')).one()
        assert row == ('vm', '["171.253.170.167"]', None)
    engine.dispose()

@pytest.mark.asyncio
async def test_refresh_failure_does_not_overwrite_existing_vip_data():
    from fastapi import HTTPException
    row = AllServerInventorySnapshot(elastic_vip_ip=['171.253.170.168'])
    db = SimpleNamespace(scalar=AsyncMock(return_value=row), commit=AsyncMock(), add=AsyncMock())
    with patch('app.api.routers.cloud._accessible_projects', new=AsyncMock(return_value=[{'id': 'project'}])), \
         patch('app.api.routers.cloud.get_zones', new=AsyncMock(return_value=[])), \
         patch('app.api.routers.cloud.cloud_v1.call', new=AsyncMock(return_value=({'elastic_ip': [{'id': 'parent', 'allowed_vips': ['vip']}]}, 200))), \
         patch('app.api.routers.cloud._project_elastic_ips', new=AsyncMock(side_effect=HTTPException(502, 'Elastic IP API unavailable'))), \
         patch('app.api.routers.cloud.write_audit', new=AsyncMock()):
        result = await refresh_all_server_inventory_servers({'items': [{'project_id': 'project', 'server_id': 'vm'}]}, ('token', None), None, None, db)
    assert result['items'][0]['status'] == 'failed'
    assert row.elastic_vip_ip == ['171.253.170.168']
    db.scalar.assert_not_awaited()


@pytest.mark.asyncio
async def test_project_selection_filters_before_pagination_and_scopes_sql_search():
    from datetime import datetime, timezone
    from app.api.routers.cloud import all_server_inventory_project_options, all_server_inventory_sql_search

    engine = create_engine('sqlite://', execution_options={'schema_translate_map': {'telemetry': None}})
    AllServerInventorySnapshot.__table__.create(engine)
    with Session(engine) as session:
        for project, server in [('p1', 'vm1'), ('p1', 'vm2'), ('p2', 'vm3'), ('p3', 'vm4')]:
            session.add(AllServerInventorySnapshot(project_id=project, project_name=project,
                project_display_name=project, server_id=server, refreshed_at=datetime.now(timezone.utc)))
        session.commit()
        db = SimpleNamespace(execute=AsyncMock(side_effect=session.execute),
            scalars=AsyncMock(side_effect=session.scalars), scalar=AsyncMock(side_effect=session.scalar))
        options = await all_server_inventory_project_options(None, db)
        assert [item['id'] for item in options['items']] == ['p1', 'p2', 'p3']
        result = await all_server_inventory(('token', None), None, db, project_ids=' p1,p2,p1 ', page_size=1)
        assert result['total'] == 3
        assert len(result['items']) == 1
        assert result['items'][0]['project_id'] in {'p1', 'p2'}
        assert (await all_server_inventory(('token', None), None, db))['total'] == 4
        assert (await all_server_inventory(('token', None), None, db, project_ids='missing'))['total'] == 0
        result = await all_server_inventory_sql_search(
            {'sql_query': 'SELECT * FROM all_server_inventory_snapshots', 'project_ids': 'p2'},
            ('token', None), None, None, db)
        assert result['total'] == 1
        assert result['items'][0]['project_id'] == 'p2'
    engine.dispose()
