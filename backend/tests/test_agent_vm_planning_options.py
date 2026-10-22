from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.api.routers import cloud_init_templates, server_creation_options
from app.provisioning.router import deployment_schema


@pytest.mark.asyncio
async def test_region_catalog_uses_fixed_read_path_and_project(monkeypatch):
    call = AsyncMock(return_value=({"results": [{"region": "r1", "region_name": "public"}], "count": 1}, 200))
    monkeypatch.setattr(server_creation_options.cloud_v1, "call", call)
    result = await server_creation_options.regions(("project", "token", "approval"), "user", "db", q="public", page=1, page_size=50)
    assert result["items"] == [{"region": "r1", "region_name": "public"}]
    call.assert_awaited_once_with("db", "user", "token", "GET", "/legacy/api/infra/server-regions/", "project",
                                  params={"page": 1, "page_size": 50, "q": "public"}, approval="approval")


@pytest.mark.asyncio
async def test_template_planning_returns_variable_names_without_script(monkeypatch):
    template = SimpleNamespace(id="t1", name="Linux", description="Deploy", os_family="ubuntu", is_active=True,
                               content="script secret-value {{server.name}} {{custom_field}} {{volume[1].size}} {{subnet_cidr}}")
    monkeypatch.setattr(cloud_init_templates, "owned", AsyncMock(return_value=template))
    result = await cloud_init_templates.template_planning_options("t1", ("p", "t", None), "user", "db")
    assert result["custom_variables"] == ["custom_field"]
    assert result["derived_variables"] == ["server.name", "subnet_cidr", "volume[1].size"]
    assert "secret-value" not in str(result)
    assert "content" not in result


@pytest.mark.asyncio
async def test_deployment_contract_contains_actual_required_fields_and_options():
    result = await deployment_schema(("p", "t", None), "user")
    schema = result["schema"]
    assert "servers" in schema["required"]
    server = schema["$defs"]["ServerSpec"]
    assert server["properties"]["instance_family"]["enum"] == ["basic", "gpu"]
    assert "subnet_id" in server["properties"]
