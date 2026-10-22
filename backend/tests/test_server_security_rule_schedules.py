from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.dialects import sqlite

from app.api.routers.security_groups import security_group_rules


@pytest.mark.asyncio
async def test_rule_list_includes_scoped_deletion_schedule():
    expiry = datetime(2026, 12, 1, 10, 30)
    db = SimpleNamespace(scalars=AsyncMock(return_value=SimpleNamespace(
        all=lambda: [SimpleNamespace(rule_id="scheduled-rule", delete_at=expiry)]
    )))
    rows = [{"id": "scheduled-rule"}, {"id": "permanent-rule"}]
    with patch("app.api.routers.security_groups.all_resource_pages", new=AsyncMock(return_value=rows)):
        result = await security_group_rules("sg-a", ("project-a", "token", None), None, db, "ingress")
    assert result == [
        {"id": "scheduled-rule", "delete_at": expiry},
        {"id": "permanent-rule", "delete_at": None},
    ]
    assert "delete_at" not in rows[0]
    db.scalars.assert_awaited_once()
    query = str(db.scalars.call_args.args[0].compile(
        dialect=sqlite.dialect(), compile_kwargs={"literal_binds": True}
    ))
    assert "project_id = 'project-a'" in query
    assert "security_group_id = 'sg-a'" in query
    assert "status = 'scheduled'" in query
    assert "rule_id IN ('scheduled-rule', 'permanent-rule')" in query


@pytest.mark.asyncio
async def test_empty_rules_skip_schedule_query():
    db = SimpleNamespace(scalars=AsyncMock())
    with patch("app.api.routers.security_groups.all_resource_pages", new=AsyncMock(return_value=[])):
        assert await security_group_rules("sg-a", ("project-a", "token", None), None, db) == []
    db.scalars.assert_not_awaited()
