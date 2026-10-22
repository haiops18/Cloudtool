import pytest
import sqlalchemy as sa
from fastapi import FastAPI
from pydantic import ValidationError

from app.api.routers import cloud, terraform, terraform_gateway
from app.db.remove_share_monitor import remove_share_monitor


def test_removal_is_repeatable_and_preserves_other_permissions():
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    users = sa.Table(
        "users", metadata,
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("permissions", sa.JSON),
    )
    monitor = sa.Table("monitor_projects", metadata, sa.Column("id", sa.String))
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(users.insert(), [
            {"id": "operator", "permissions": ["servers", "share_monitor", "private_ips"]},
            {"id": "viewer", "permissions": None},
        ])
        connection.execute(monitor.insert(), {"id": "old-config"})
        remove_share_monitor(connection)
        remove_share_monitor(connection)
        assert not sa.inspect(connection).has_table("monitor_projects")
        assert dict(connection.execute(sa.select(users)).all()) == {
            "operator": ["servers", "private_ips"], "viewer": None,
        }


def test_share_monitor_endpoints_and_terraform_action_are_removed():
    app = FastAPI()
    app.include_router(cloud.router)
    assert not any(
        "share-monitor" in path or "monitor-projects" in path
        for path in app.openapi()["paths"]
    )
    with pytest.raises(ValidationError):
        terraform.TerraformJobIn(environment="demo", action="attach-monitor")
    assert not terraform_gateway._allowed("POST", "infra/vpcs/12345678/share/")
