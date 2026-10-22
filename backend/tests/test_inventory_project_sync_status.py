from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routers.cloud import all_server_inventory_projects
from app.core.time import app_timezone
from app.models.entities import AllServerInventorySnapshot, AuditLog


@pytest.mark.asyncio
async def test_project_sync_status_uses_inventory_and_success_audits_and_prioritizes_unsynced():
    engine = create_engine('sqlite://', execution_options={'schema_translate_map': {'telemetry': None}})
    for table in (AllServerInventorySnapshot.__table__, AuditLog.__table__):
        table.create(engine)
    def stamp(day):
        return datetime(2026, 10, day, 12, tzinfo=app_timezone()).replace(tzinfo=None)
    accessible = [
        {'id': 'legacy', 'name': 'Legacy', 'display_name': 'Legacy'},
        {'id': 'empty', 'name': 'Empty', 'display_name': 'Empty'},
        {'id': 'new', 'name': 'New', 'display_name': 'New'},
        {'id': 'failed', 'name': 'Failed', 'display_name': 'Failed'},
    ]
    with Session(engine) as session:
        session.execute(AllServerInventorySnapshot.__table__.insert(), [
            {'id': 'vm1', 'project_id': 'legacy', 'server_id': '1', 'refreshed_at': stamp(2)},
            {'id': 'vm2', 'project_id': 'legacy', 'server_id': '2', 'refreshed_at': stamp(3)},
            {'id': 'hidden', 'project_id': 'inaccessible', 'server_id': '1', 'refreshed_at': stamp(4)},
        ])
        for project, result, day in [('empty', 'success', 2), ('empty', 'failed', 5), ('failed', 'failed', 5)]:
            event_id = f'{project}-{day}'
            session.execute(AuditLog.__table__.insert().values(
                id=event_id, created_at=stamp(day), project_id=project,
                action='all_server_inventory.sync_project', result=result,
                correlation_id=event_id, metadata_json={'servers': 0},
            ))
        session.commit()
        db = SimpleNamespace(execute=AsyncMock(side_effect=session.execute))
        with patch('app.api.routers.cloud._accessible_projects', new=AsyncMock(return_value=accessible)):
            result = await all_server_inventory_projects(('token', None), SimpleNamespace(id='user'), db)
        assert result['total'] == 4
        assert [item['id'] for item in result['items']] == ['failed', 'new', 'empty', 'legacy']
        by_id = {item['id']: item for item in result['items']}
        assert by_id['legacy']['last_synced_at'] == '2026-10-03T12:00:00+07:00'
        assert by_id['empty']['is_synced'] is True
        assert by_id['empty']['last_synced_at'] == '2026-10-02T12:00:00+07:00'
        assert by_id['failed']['is_synced'] is False
        assert by_id['new']['last_synced_at'] is None
        assert db.execute.await_count == 2
        assert all('is_synced' not in item for item in accessible)
    engine.dispose()


@pytest.mark.asyncio
async def test_no_accessible_projects_skips_database_queries():
    db = SimpleNamespace(execute=AsyncMock())
    with patch('app.api.routers.cloud._accessible_projects', new=AsyncMock(return_value=[])):
        result = await all_server_inventory_projects(('token', None), SimpleNamespace(id='user'), db)
    assert result == {'items': [], 'total': 0}
    db.execute.assert_not_awaited()

def test_inventory_row_includes_timezone_for_fractional_sync_age():
    from app.api.routers.cloud import _all_inventory_row
    row = AllServerInventorySnapshot(
        id='vm', project_id='project', server_id='vm', server_name='VM',
        refreshed_at=datetime(2026, 10, 5, 12, tzinfo=app_timezone()).replace(tzinfo=None),
    )
    assert _all_inventory_row(row)['refreshed_at'] == '2026-10-05T12:00:00+07:00'
