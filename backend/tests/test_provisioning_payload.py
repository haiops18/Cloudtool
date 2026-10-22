from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.models import Role
from app.provisioning.router import queue_deployment, resolve_current_cloud_init_templates
from app.provisioning.schemas import DeploymentCreate
from app.provisioning.service import _create_server
from app.provisioning.variables import cloud_init_values, render_cloud_init_variables


def admin_user():
    return SimpleNamespace(role=Role.admin, permissions=[], cloud_api_access="full")


@pytest.mark.parametrize("mode,enabled,address", [
    ("none", "false", ""), ("auto", "true", ""), ("existing", "true", "203.0.113.42"),
])
def test_elastic_ip_variables_follow_selected_mode_and_ignore_custom_overrides(mode, enabled, address):
    server = manifest(mode).servers[0]
    server.elastic_ip_address = "203.0.113.42"
    server.cloud_init_variables = {"elastic_ip_enabled": "wrong", "elastic_ip_address": "wrong"}
    values = cloud_init_values(server)
    assert values["elastic_ip_enabled"] == enabled
    assert values["elastic_ip_address"] == address
    assert render_cloud_init_variables("enabled={{ elastic_ip_enabled }}", server) == f"enabled={enabled}"


def test_auto_ip_address_is_not_guessed_and_unrelated_templates_are_unchanged():
    server = manifest("auto").servers[0]
    with pytest.raises(ValueError, match="automatic allocation"):
        render_cloud_init_variables("address={{ elastic_ip_address }}", server)
    assert render_cloud_init_variables("name={{server_name}}", server) == "name=app-01"


def test_elastic_address_is_empty_when_disabled_and_rejects_resource_labels():
    server = manifest("none").servers[0]
    server.elastic_ip_address = "203.0.113.42"
    assert render_cloud_init_variables('ip="{{elastic_ip_address}}"', server) == 'ip=""'
    server.elastic_ip_mode = "existing"
    server.elastic_ip_address = "Elastic IP resource name"
    with pytest.raises(ValueError, match="valid address"):
        render_cloud_init_variables("{{elastic_ip_address}}", server)


@pytest.mark.parametrize("prefix", ["\ufeff", "\r\n\r\n", " \t\ufeff\n"])
@pytest.mark.parametrize("header", ["#ps1", "#ps1_sysnative", "#ps1_x86"])
def test_windows_userdata_header_is_at_byte_zero_after_paste(prefix, header):
    content = header + "\r\nWrite-Host '{{server_name}}'\r\n"
    server = manifest("none").servers[0]
    assert render_cloud_init_variables(prefix + content, server) == content.replace("{{server_name}}", server.name)


def test_non_windows_userdata_whitespace_is_preserved():
    content = "\n#cloud-config\npackages: []\n"
    assert render_cloud_init_variables(content, manifest("none").servers[0]) == content


@pytest.mark.asyncio
@pytest.mark.parametrize("template_project", ["project", "different-project"])
async def test_deploy_uses_updated_template_instead_of_stale_saved_draft(template_project):
    body = manifest("none")
    server = body.servers[0]
    server.cloud_init_enabled = True
    server.cloud_init_template_id = "windows-template"
    server.cloud_init_content = "#ps1\n# old copy from saved draft\n"
    latest = "#ps1\nWrite-Host 'new template'\n"
    db = AsyncMock()
    db.get.return_value = SimpleNamespace(project_id=template_project, content=latest)
    resolved = await resolve_current_cloud_init_templates(body, "project", db)
    assert resolved.servers[0].cloud_init_content == latest
    assert body.servers[0].cloud_init_content != latest
    assert resolved.servers[0].cloud_init_template_id == "windows-template"


@pytest.mark.asyncio
@pytest.mark.parametrize("template_project", ["project", "different-project"])
async def test_queue_snapshots_updated_template_for_manifest_logs_and_background_task(monkeypatch, template_project):
    body = manifest("none")
    body.servers[0].cloud_init_enabled = True
    body.servers[0].cloud_init_template_id = "windows-template"
    body.servers[0].cloud_init_content = "#ps1\n# stale draft\n"
    latest = "#ps1\nWrite-Host 'updated'\n"
    db = SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(project_id=template_project, content=latest)),
                         add=Mock(), commit=AsyncMock(), refresh=AsyncMock())
    background = SimpleNamespace(add_task=Mock())
    monkeypatch.setattr("app.provisioning.router.write_audit", AsyncMock())
    user = SimpleNamespace(id="user", email="admin@example.test")
    item = await queue_deployment(body, background, ("project", "token", None), user, db)
    assert "cloud_init_content" not in item.manifest_json["servers"][0]
    assert "cloud_init_content" not in item.servers[0].request_json
    assert item.servers[0].request_json["cloud_init_template_id"] == "windows-template"
    assert item.servers[0].request_json["cloud_init_mode"] == "template"
    assert background.add_task.call_args.args[4]["servers"][0]["cloud_init_content"] == latest


@pytest.mark.asyncio
async def test_custom_or_disabled_cloud_init_is_not_replaced():
    body = manifest("none")
    body.servers[0].cloud_init_enabled = True
    body.servers[0].cloud_init_content = "#ps1\n# custom content\n"
    db = AsyncMock()
    resolved = await resolve_current_cloud_init_templates(body, "project", db)
    assert resolved.servers[0].cloud_init_content == body.servers[0].cloud_init_content
    db.get.assert_not_awaited()
    body.servers[0].cloud_init_enabled = False
    body.servers[0].cloud_init_template_id = "disabled-template"
    await resolve_current_cloud_init_templates(body, "project", db)
    db.get.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_template_is_rejected():
    from fastapi import HTTPException

    body = manifest("none")
    body.servers[0].cloud_init_enabled = True
    body.servers[0].cloud_init_template_id = "unavailable"
    db = AsyncMock()
    db.get.return_value = None
    with pytest.raises(HTTPException, match="unavailable"):
        await resolve_current_cloud_init_templates(body, "project", db)


@pytest.mark.asyncio
async def test_existing_elastic_address_is_rendered_in_raw_cloud_init_without_payload_changes(monkeypatch):
    deployment = manifest("existing")
    server = deployment.servers[0]
    server.elastic_ip_address = "203.0.113.42"
    server.cloud_init_enabled = True
    server.cloud_init_content = '#cloud-config\nwrite_files:\n  - path: /etc/eip\n    content: "{{elastic_ip_enabled}} {{elastic_ip_address}}"\n'
    call = AsyncMock(return_value=({"id": "server-1"}, 201))
    monkeypatch.setattr("app.provisioning.service.cloud_v1.create_resource", call)
    await _create_server(AsyncMock(), admin_user(), "token", "project", deployment, server, None, "correlation")
    payload = call.await_args.args[5]
    assert payload["user_data"] == server.cloud_init_content.replace("{{elastic_ip_enabled}}", "true").replace("{{elastic_ip_address}}", "203.0.113.42")
    assert payload["elastic_ip"] == "eip-1"
    assert payload["enable_elastic_ip"] is True


@pytest.fixture(autouse=True)
def skip_network_hydration(monkeypatch):
    """Payload unit tests must not issue unrelated subnet/VPC API requests."""
    async def no_hydration(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.provisioning.service._hydrate_private_network", no_hydration)


def manifest(elastic_ip_mode: str):
    return DeploymentCreate.model_validate({
        "name": "test", "region": "vn-central-1", "servers": [{
            "name": "app-01", "zone_id": "zone-1", "region_id": "region-1",
            "instance_family": "basic", "specs_kind": "predefined",
            "flavor_name": "custom-2C-4GB", "image_name": "ubuntu-24",
            "key_pair_id": "key-1", "enable_ipv4": True,
            "elastic_ip_mode": elastic_ip_mode,
            "elastic_ip_id": "eip-1" if elastic_ip_mode == "existing" else None,
            "subnet_id": "subnet-1", "security_group_ids": ["sg-1"],
            "volumes": [{"volume_type": "volume-type-1", "size": 50, "mount_as": "root"}],
            "cloud_init_enabled": False,
        }],
    })


@pytest.mark.asyncio
@pytest.mark.parametrize(("mode", "expected"), [("auto", True), ("existing", True), ("none", False)])
async def test_elastic_ip_payload_matches_cloud_contract(monkeypatch, mode, expected):
    body = manifest(mode)
    call = AsyncMock(return_value=({"id": "server-1", "name": "app-01"}, 201))
    monkeypatch.setattr("app.provisioning.service.cloud_v1.create_resource", call)

    await _create_server(
        AsyncMock(), admin_user(), "Token test", "project-1", body,
        body.servers[0], None, "correlation-1",
    )

    sent = call.await_args.args[5]
    assert sent["enable_elastic_ip"] is expected
    assert sent["bandwidth"] == 300
    assert (sent.get("elastic_ip") == "eip-1") is (mode == "existing")


@pytest.mark.asyncio
async def test_cloud_init_is_sent_as_raw_json_string(monkeypatch):
    deployment = manifest("none")
    deployment.servers[0].cloud_init_enabled = True
    deployment.servers[0].cloud_init_content = "#cloud-config\npackages:\n  - nginx\n"
    call = AsyncMock(return_value=({"id": "server-1", "name": "app-01"}, 201))
    monkeypatch.setattr("app.provisioning.service.cloud_v1.create_resource", call)

    await _create_server(
        AsyncMock(), admin_user(), "Token test", "project-1", deployment,
        deployment.servers[0], None, "correlation-1",
    )

    assert call.await_args.args[5]["user_data"] == "#cloud-config\npackages:\n  - nginx\n"


@pytest.mark.asyncio
async def test_complex_cloud_init_quotes_and_heredocs_remain_raw(monkeypatch):
    deployment = manifest("none")
    deployment.servers[0].cloud_init_enabled = True
    content = """#cloud-config
runcmd:
  - |
    set -Eeuo pipefail
    token='REPLACE_WITH_TELEPORT_JOIN_TOKEN'
    cat > /etc/example.conf <<'EOF'
    key: \"value\"
    EOF
"""
    deployment.servers[0].cloud_init_content = content
    call = AsyncMock(return_value=({"id": "server-1", "name": "app-01"}, 201))
    monkeypatch.setattr("app.provisioning.service.cloud_v1.create_resource", call)

    await _create_server(
        AsyncMock(), admin_user(), "Token test", "project-1", deployment,
        deployment.servers[0], None, "correlation-1",
    )

    assert call.await_args.args[5]["user_data"] == content
