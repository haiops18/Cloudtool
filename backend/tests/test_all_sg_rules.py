from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routers.security_groups import (
    all_scheduled_security_group_rules, all_scheduled_rule_projects,
    delete_scheduled_security_group_rules,
)
from app.models.entities import SecurityGroupRuleDeletionSchedule as Schedule
from app.schemas.common import SecurityGroupRuleDeleteBatch


@pytest.mark.asyncio
async def test_local_schedule_pagination_filters_counts_and_failed_retry():
    engine = create_engine('sqlite://')
    Schedule.__table__.create(engine)
    now = datetime(2026, 10, 7, 12)
    with Session(engine) as session:
        for rule, project, day, status in [
            ('due', 'project-a', 1, 'scheduled'),
            ('future', 'project-b', 20, 'scheduled'),
            ('failed', 'project-a', 3, 'failed'),
            ('deleted', 'project-a', 2, 'deleted'),
            ('literal%rule', 'project-b', 21, 'scheduled'),
        ]:
            session.add(Schedule(id=rule, rule_id=rule, project_id=project,
                security_group_id='sg', delete_at=datetime(2026, 10, day, 12), status=status))
        session.commit()
        db = SimpleNamespace(scalar=AsyncMock(side_effect=session.scalar), scalars=AsyncMock(side_effect=session.scalars))
        async def listing(**kwargs):
            params = dict(user=None, db=db, page=1, page_size=1, search='', project_ids=[], timing='all')
            params.update(kwargs)
            return await all_scheduled_security_group_rules(**params)
        with patch('app.api.routers.security_groups.db_now', return_value=now):
            result = await listing()
            assert result['total'] == 4 and result['due'] == 2 and result['upcoming'] == 2
            assert result['items'][0]['rule_id'] == 'due'
            assert result['items'][0]['is_due'] is True
            assert result['items'][0]['delete_at'].endswith('+07:00')
            assert (await listing(page=2))['items'][0]['rule_id'] == 'failed'
            assert (await listing(project_ids=['project-a'], page_size=50))['total'] == 2
            assert (await listing(timing='upcoming'))['total'] == 2
            assert (await listing(timing='due'))['total'] == 2
            assert (await listing(search='%'))['total'] == 1
            assert (await listing(search='nothing'))['total'] == 0
            assert (await listing(page=9))['items'] == []
            projects = await all_scheduled_rule_projects(None, db)
            assert projects == {'items': [{'id': 'project-a'}, {'id': 'project-b'}]}
        db.commit = AsyncMock()
        with patch('app.api.routers.security_groups.delete_rule', new=AsyncMock()) as delete, \
             patch('app.api.routers.security_groups.mark_rule_schedule_deleted', new=AsyncMock()), \
             patch('app.api.routers.security_groups.write_audit', new=AsyncMock()):
            result = await delete_scheduled_security_group_rules(
                SecurityGroupRuleDeleteBatch(rule_ids=['failed', 'future']),
                ('project-a', 'token', None), None, None, db,
            )
            assert [row['status'] for row in result['items']] == ['deleted', 'failed']
            delete.assert_awaited_once()
            assert delete.call_args.args[3] == 'project-a'
            assert delete.call_args.args[-1] == 'failed'
    engine.dispose()

@pytest.mark.asyncio
async def test_project_names_reuses_cloud_discovery_without_selected_project():
    from app.api.routers.security_groups import scheduled_rule_project_names
    db = SimpleNamespace()
    user = SimpleNamespace(id='sg-user')
    projects = [{'id': 'project-a', 'name': 'Project A', 'display_name': 'Display A'}]
    with patch('app.api.routers.cloud._accessible_projects', new=AsyncMock(return_value=projects)) as discovery:
        assert await scheduled_rule_project_names(('token', None), user, db) == {'items': projects}
        discovery.assert_awaited_once_with(db, user, 'token', None)

@pytest.mark.asyncio
async def test_due_preview_and_execution_verify_names_membership_and_cutoff():
    from app.api.routers.security_groups import preview_due_rule_deletion, delete_all_due_rules, DueRuleDeletion
    from pydantic import ValidationError
    engine = create_engine('sqlite://')
    Schedule.__table__.create(engine)
    with Session(engine) as session:
        for rule, project, sg, day in [('safe', 'a', 'sg', 1), ('wrong-sg', 'a', 'sg', 1), ('nameless', 'b', 'sg', 1), ('future', 'a', 'sg', 20)]:
            session.add(Schedule(id=rule, rule_id=rule, project_id=project, security_group_id=sg, delete_at=datetime(2026, 10, day)))
        session.commit()
        db = SimpleNamespace(scalars=AsyncMock(side_effect=session.scalars))
        async def resource(db, user, token, project, kind, **kwargs):
            if kind == 'security-groups':
                return [{'id': 'sg', 'name': 'Firewall'}]
            return [{'id': 'safe', 'security_group': 'sg'}, {'id': 'wrong-sg', 'security_group': 'other'}, {'id': 'future', 'security_group': 'sg'}]
        with patch('app.api.routers.cloud._accessible_projects', new=AsyncMock(return_value=[{'id': 'a', 'name': 'Project A'}, {'id': 'b', 'name': 'b'}])), \
             patch('app.api.routers.security_groups.all_resource_pages', side_effect=resource), \
             patch('app.api.routers.security_groups.db_now', return_value=datetime(2026, 10, 8)), \
             patch('app.api.routers.security_groups.delete_scheduled_security_group_rules', new=AsyncMock(return_value={'items': [{'rule_id': 'safe', 'status': 'deleted'}]})) as delete:
            assert await preview_due_rule_deletion(('token', None), None, db) == {'schedule_ids': ['safe'], 'eligible': 1, 'skipped': 2}
            with pytest.raises(ValidationError):
                DueRuleDeletion(confirmation='DELETE', schedule_ids=['safe'])
            result = await delete_all_due_rules(DueRuleDeletion(confirmation='DELETE ALL DUE SG RULES', schedule_ids=['safe', 'wrong-sg', 'nameless', 'future']), ('token', None), None, None, db)
            assert result['skipped'] == 3
            delete.assert_awaited_once()
            assert delete.call_args.args[0].rule_ids == ['safe']
            assert delete.call_args.args[1][0] == 'a'
    engine.dispose()

@pytest.mark.asyncio
async def test_single_delete_opt_in_verification_blocks_unverifiable_rule():
    row = SimpleNamespace(project_id='a', rule_id='missing', security_group_id='sg')
    db = SimpleNamespace(scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: [row])), commit=AsyncMock())
    with patch('app.api.routers.security_groups.verified_schedules', new=AsyncMock(return_value=[])) as verify, \
         patch('app.api.routers.security_groups.delete_rule', new=AsyncMock()) as delete, \
         patch('app.api.routers.security_groups.write_audit', new=AsyncMock()):
        result = await delete_scheduled_security_group_rules(SecurityGroupRuleDeleteBatch(rule_ids=['missing'], verify_exists=True), ('a', 'token', None), None, None, db)
        verify.assert_awaited_once()
        delete.assert_not_awaited()
        assert result['items'][0]['status'] == 'failed'
