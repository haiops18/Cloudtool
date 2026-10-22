from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.provisioning.history import compact_history
from app.provisioning.router import view


def test_compact_history_removes_only_cloud_init_bodies_without_mutating_execution_data():
    original = {
        "servers": [{"name": "vm", "cloud_init_content": "large raw content",
                     "rendered_cloud_init": "large rendered content", "cloud_init_template_id": "template",
                     "cloud_init_enabled": True, "cloud_init_mode": "template", "nested": {"volume": 50}}],
        "region": "region", "execution_mode": "standard",
    }
    compact = compact_history(original)
    assert "cloud_init_content" not in compact["servers"][0]
    assert "rendered_cloud_init" not in compact["servers"][0]
    assert compact["servers"][0]["cloud_init_template_id"] == "template"
    assert compact["servers"][0]["cloud_init_enabled"] is True
    assert compact["servers"][0]["nested"] == {"volume": 50}
    assert original["servers"][0]["cloud_init_content"] == "large raw content"
    assert compact["region"] == "region"


def test_legacy_history_responses_omit_cloud_init_content_without_changing_stored_rows():
    request = {"name": "vm", "cloud_init_content": "raw", "rendered_cloud_init": "rendered"}
    result = {"cloud_response": {"id": "vm", "cloud_init_content": "echo"}}
    row = SimpleNamespace(id="log", server_name="vm", server_id="vm", status="succeeded",
                          error_code=None, error_message=None, request_json=request, result_json=result,
                          created_at=None, started_at=None, completed_at=None)
    deployment = SimpleNamespace(id="deployment", project_id="project", name="Deployment", status="succeeded",
                                 total_items=1, succeeded_items=1, failed_items=0, actor_email="user", error=None,
                                 created_at=None, started_at=None, completed_at=None,
                                 manifest_json={"servers": [request]}, servers=[row])
    response = view(deployment)
    assert response["template"]["servers"] == [{"name": "vm"}]
    assert response["servers"][0]["request"] == {"name": "vm"}
    assert response["servers"][0]["result"] == {"cloud_response": {"id": "vm"}}
    assert row.request_json == request and request["cloud_init_content"] == "raw"


@pytest.mark.asyncio
async def test_background_creation_keeps_full_cloud_init_without_persisting_it(monkeypatch):
    from app.provisioning import service

    content = "#cloud-config\nhostname: '{{server_name}}'\n"
    manifest = {"name": "Deployment", "region": "region", "servers": [{
        "name": "vm", "subnet_id": "subnet", "cloud_init_enabled": True, "cloud_init_content": content,
    }]}
    log = SimpleNamespace(id="log", server_name="vm", status="pending", server_id=None,
                          request_json={"name": "vm", "cloud_init_enabled": True}, result_json={})
    deployment = SimpleNamespace(id="deployment", user_id="user", project_id="project", status="queued",
                                 correlation_id="correlation", total_items=1, succeeded_items=0, failed_items=0,
                                 manifest_json=compact_history(manifest), servers=[log])
    db = AsyncMock()
    db.scalar.return_value = deployment
    db.get.return_value = SimpleNamespace(id="user")
    session = MagicMock()
    session.__aenter__.return_value = db
    monkeypatch.setattr(service, "SessionFactory", lambda: session)
    cloud_response = {"id": "created-vm", "status": "running", "cloud_init_content": "echo"}
    create = AsyncMock(return_value=cloud_response)
    monkeypatch.setattr(service, "_create_server", create)
    monkeypatch.setattr(service, "write_audit", AsyncMock())

    await service.run_deployment("deployment", "token", None, manifest)

    assert create.await_args.args[5].cloud_init_content == content
    assert "rendered_cloud_init" not in log.request_json
    assert "cloud_init_content" not in log.request_json
    assert "cloud_init_content" not in log.result_json["cloud_response"]
    assert cloud_response["cloud_init_content"] == "echo"
    assert log.server_id == "created-vm"
    assert log.status == "succeeded"
    assert deployment.succeeded_items == 1
