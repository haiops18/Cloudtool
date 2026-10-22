from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routers.cloud import all_server_inventory, all_server_inventory_sql_search
from app.models.entities import AllServerInventorySnapshot


@pytest.mark.asyncio
async def test_zone_and_power_state_filter_database_results_before_pagination():
    engine = create_engine("sqlite://", execution_options={"schema_translate_map": {"telemetry": None}})
    AllServerInventorySnapshot.__table__.create(engine)
    with Session(engine) as session:
        for server, zone, name, power, status in [
            ("a", "zone-id", "Hanoi", "running", "active"),
            ("b", "zone-id", "Hanoi", "stopped", "active"),
            ("c", "Danang", "", "running", "active"),
            ("d", "zone-id", "Hanoi", "running", "deleted"),
        ]:
            session.add(AllServerInventorySnapshot(project_id="project", project_name="Project",
                server_id=server, zone=zone, zone_name=name, power_state=power,
                inventory_status=status, refreshed_at=datetime.now(UTC)))
        session.commit()
        db = SimpleNamespace(scalar=AsyncMock(side_effect=session.scalar), scalars=AsyncMock(side_effect=session.scalars))
        result = await all_server_inventory(("token", None), None, db, zone=" HANOI ", power_state=" RUN ", page_size=1)
        assert result["total"] == 1
        assert result["items"][0]["server_id"] == "a"
        result = await all_server_inventory(("token", None), None, db, zone="danang", power_state="running")
        assert result["items"][0]["server_id"] == "c"
        result = await all_server_inventory(("token", None), None, db, zone="hanoi", power_state="deleted")
        assert result["total"] == 0
        assert result["items"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("filters", [
    {},
    {"q": "deleted-vm"},
    {"power_state": "deleted"},
    {"batch_fields": "server_id", "batch_values": "deleted-vm"},
    {"sql_query": "SELECT * FROM all_server_inventory_snapshots"},
    {"sql_query": "SELECT * FROM all_server_inventory_snapshots WHERE inventory_status = 'deleted'"},
    {"page_size": 500},
])
async def test_deleted_vms_are_excluded_from_load_search_sql_and_export(filters):
    engine = create_engine("sqlite://", execution_options={"schema_translate_map": {"telemetry": None}})
    AllServerInventorySnapshot.__table__.create(engine)
    with Session(engine) as session:
        session.add(AllServerInventorySnapshot(project_id="project", project_name="Project",
            server_id="active-vm", server_name="Active VM", power_state="running",
            inventory_status="active", refreshed_at=datetime.now(UTC)))
        for index, markers in enumerate([
            {"inventory_status": "deleted"},
            {"power_state": "deleted"},
            {"status": "DELETED"},
            {"deleted_at": datetime.now(UTC)},
        ]):
            session.add(AllServerInventorySnapshot(**{
                "project_id": "project", "project_name": "Project",
                "server_id": f"deleted-vm-{index}", "server_name": "deleted-vm",
                "inventory_status": "active", "power_state": "running",
                "refreshed_at": datetime.now(UTC), **markers,
            }))
        session.commit()
        db = SimpleNamespace(scalar=AsyncMock(side_effect=session.scalar), scalars=AsyncMock(side_effect=session.scalars))
        if "sql_query" in filters:
            result = await all_server_inventory_sql_search(filters, ("token", None), None, None, db)
        else:
            result = await all_server_inventory(("token", None), None, db, **filters)
        expected_ids = [] if any(key in filters for key in ("q", "power_state", "batch_values")) or "WHERE" in filters.get("sql_query", "") else ["active-vm"]
        assert [row["server_id"] for row in result["items"]] == expected_ids
        assert result["total"] == len(expected_ids)
