from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routers.cloud_authorizations import authorization_history
from app.core.time import app_timezone
from app.models.entities import AuditLog, CloudAuthorization, User


@pytest.mark.asyncio
async def test_history_filters_owner_orders_paginates_and_keeps_deleted_logins():
    engine = create_engine('sqlite://', execution_options={'schema_translate_map': {'telemetry': None}})
    for table in (User.__table__, CloudAuthorization.__table__, AuditLog.__table__):
        table.create(engine)
    with Session(engine) as session:
        session.execute(CloudAuthorization.__table__.insert(), [{
            'id': 'saved', 'user_id': 'mine', 'name': 'Renamed', 'ciphertext': 'private-secret',
        }])
        events = [
            ('old', 'mine', 'saved', 'cloud_authorization.activate_saved', 'success', 1, {}),
            ('deleted', 'mine', 'removed', 'cloud_authorization.activate_saved', 'success', 2, {'display_name': 'Original name'}),
            ('new', 'mine', None, 'cloud_authorization.activate', 'success', 3, {}),
            ('other', 'other-user', 'saved', 'cloud_authorization.activate_saved', 'success', 4, {}),
            ('failed', 'mine', 'saved', 'cloud_authorization.activate_saved', 'failure', 5, {}),
            ('clear', 'mine', None, 'cloud_authorization.clear', 'success', 6, {}),
        ]
        for event_id, owner, target, action, result, day, metadata in events:
            session.execute(AuditLog.__table__.insert().values(
                id=event_id, user_id=owner, target_id=target, action=action, result=result,
                created_at=datetime(2026, 10, day, 12, tzinfo=app_timezone()).replace(tzinfo=None),
                correlation_id=event_id, metadata_json=metadata,
            ))
        session.commit()
        db = SimpleNamespace(execute=AsyncMock(side_effect=session.execute))
        first = await authorization_history(SimpleNamespace(id='mine'), db, offset=0, limit=2)
        assert [item['id'] for item in first['items']] == ['new', 'deleted']
        assert first['has_more'] is True
        assert first['items'][0]['kind'] == 'session'
        assert first['items'][0]['logged_in_at'] == '2026-10-03T12:00:00+07:00'
        assert first['items'][1]['name'] == 'Original name'
        assert first['items'][1]['authorization_id'] is None
        second = await authorization_history(SimpleNamespace(id='mine'), db, offset=2, limit=2)
        assert [item['id'] for item in second['items']] == ['old']
        assert second['items'][0]['name'] == 'Renamed'
        assert second['items'][0]['authorization_id'] == 'saved'
        assert second['has_more'] is False
        assert 'private-secret' not in str(first) + str(second)
    engine.dispose()
