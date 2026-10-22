import asyncio
import base64
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app import codex_cli
from app import main as agent_main
from app import mcp_server
from app import codex_terminal
from app.gateway import Caller, CloudToolGateway
from app.project_workspace import prepare_project_workspace, read_workspace_file, store_workspace_attachments, workspace_files, write_security_group_rule_template
from app.project_workspace import write_project_context_snapshot
from app.vm_actions import extract_vm_action, remove_vm_action_block
from app.api_actions import extract_security_group_rule_actions


def test_external_chat_requires_key(monkeypatch):
    monkeypatch.setattr(agent_main.settings, "AGENT_EXTERNAL_API_KEY", "test-key")
    client = TestClient(agent_main.app, base_url="http://localhost")

    response = client.post("/api/v1/external/chat", json={"message": "hello"})

    assert response.status_code == 401


def test_external_cancel_requires_key_and_is_idempotent(monkeypatch):
    monkeypatch.setattr(agent_main.settings, "AGENT_EXTERNAL_API_KEY", "test-key")
    client = TestClient(agent_main.app, base_url="http://localhost")

    denied = client.post("/api/v1/external/requests/not-running/cancel")
    accepted = client.post(
        "/api/v1/external/requests/not-running/cancel",
        headers={"X-Agent-API-Key": "test-key"},
    )

    assert denied.status_code == 401
    assert accepted.status_code == 200
    assert accepted.json() == {"request_id": "not-running", "cancelled": False}


def test_external_chat_runs_without_cloud_gateway(monkeypatch):
    monkeypatch.setattr(agent_main.settings, "AGENT_EXTERNAL_API_KEY", "test-key")

    async def fake_answer(question, evidence, attachments, runtime, session_id, request_id):
        assert question == "hello"
        assert evidence["external_api"]["note"]
        assert session_id is None
        assert request_id
        return "Codex replied", "test-model", "codex-cli", "thread-1"

    monkeypatch.setattr(agent_main, "answer", fake_answer)
    monkeypatch.setattr(agent_main, "list_conversations", lambda **_kwargs: [])
    monkeypatch.setattr(agent_main, "append_exchange", lambda **_kwargs: "conversation-1")
    monkeypatch.setattr(agent_main, "write_audit", lambda **_kwargs: None)
    client = TestClient(agent_main.app, base_url="http://localhost")

    response = client.post(
        "/api/v1/external/chat",
        headers={"X-Agent-API-Key": "test-key"},
        json={"message": "hello", "client_id": "integration"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["request_id"]
    assert {key: value for key, value in body.items() if key != "request_id"} == {
        "conversation_id": "conversation-1",
            "answer": "Codex replied",
            "evidence": [{"source": "external_api", "count": 0, "note": "No CloudTool data"}],
            "attachments": [],
            "api_action": None,
            "api_actions": [],
        "model_used": "test-model",
            "mode": "codex-cli",
            "csrf_token": None,
            "vm_action": None,
        }


def test_extracts_multiple_security_group_rule_actions_in_order():
    text = '''Create the requested rules.
```cloudtool-api-action
{"type":"security_group_rule.create","security_group_id":"sg-1","rule":{"direction":"ingress","protocol":"tcp","port_range_min":80,"port_range_max":80,"remote_ip_prefix":"0.0.0.0/0"},"summary":"HTTP"}
```
```cloudtool-api-action
{"type":"security_group_rule.create","security_group_id":"sg-1","rule":{"direction":"ingress","protocol":"tcp","port_range_min":443,"port_range_max":443,"remote_ip_prefix":"0.0.0.0/0"},"summary":"HTTPS"}
```'''

    actions = extract_security_group_rule_actions(text)

    assert [action["rule"]["port_range_min"] for action in actions] == [80, 443]


def test_codex_resume_command_uses_current_cli_shape(monkeypatch, tmp_path):
    captured = {}
    output_path = tmp_path / "result.txt"

    monkeypatch.setattr(codex_cli, "_command", lambda _value: "codex")
    monkeypatch.setattr(codex_cli, "_workdir", lambda _value: str(tmp_path))

    async def fake_create_subprocess(*command, **_kwargs):
        captured["command"] = command
        path = Path(command[command.index("--output-last-message") + 1])
        path.write_text("done", encoding="utf-8")
        return type("Process", (), {"returncode": 0})()

    async def fake_communicate(_process, _prompt):
        return json.dumps({"type": "thread.started", "thread_id": "thread-2"}) + "\n", ""

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess)
    monkeypatch.setattr(codex_cli, "_communicate", fake_communicate)
    monkeypatch.setattr(codex_cli.tempfile, "NamedTemporaryFile", lambda **_kwargs: type("Temp", (), {"name": str(output_path), "close": lambda self: None})())

    text, _model, session_id = asyncio.run(codex_cli.answer(
        question="hello", evidence={}, config={"command": "codex", "workdir": str(tmp_path), "reasoning_effort": "medium", "timeout_seconds": 30}, session_id="old-thread"
    ))

    command = captured["command"]
    assert command[command.index("exec") + 1] == "resume"
    assert command[command.index("resume") + 1] == "--json"
    assert command[-2:] == ("old-thread", "-")
    assert text == "done"
    # A resumed session remains identified by the existing thread, even when
    # the CLI happens to print an additional event.
    assert session_id == "thread-2"


def test_codex_passes_the_selected_model_and_reasoning_to_the_cli(monkeypatch, tmp_path):
    captured = {}
    output_path = tmp_path / "result.txt"

    monkeypatch.setattr(codex_cli, "_command", lambda _value: "codex")
    monkeypatch.setattr(codex_cli, "_workdir", lambda _value: str(tmp_path))

    async def fake_create_subprocess(*command, **_kwargs):
        captured["command"] = command
        Path(command[command.index("--output-last-message") + 1]).write_text("done", encoding="utf-8")
        return type("Process", (), {"returncode": 0})()

    async def fake_communicate(_process, _prompt):
        return "", ""

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess)
    monkeypatch.setattr(codex_cli, "_communicate", fake_communicate)
    monkeypatch.setattr(codex_cli.tempfile, "NamedTemporaryFile", lambda **_kwargs: type("Temp", (), {"name": str(output_path), "close": lambda self: None})())

    asyncio.run(codex_cli.answer(
        question="hello", evidence={},
        config={"command": "codex", "workdir": str(tmp_path), "model": "gpt-5.3-codex", "reasoning_effort": "xhigh", "timeout_seconds": 30},
    ))

    command = captured["command"]
    assert command[command.index("--model") + 1] == "gpt-5.3-codex"
    assert 'model_reasoning_effort="xhigh"' in command


def test_chat_does_not_resume_a_thread_created_with_another_model(monkeypatch):
    captured = {}

    async def fake_caller(_request):
        return Caller("user@example.test", "user", "project-1", "token", "cookie", "csrf")

    async def fake_answer(_question, _context, _attachments, _runtime, session_id, _request_id, _mcp_context, _dynamic_tool_handler):
        captured["session_id"] = session_id
        return "answer", "gpt-5.6-terra", "codex-cli", "new-thread"

    monkeypatch.setattr(agent_main.gateway, "caller", fake_caller)
    monkeypatch.setattr(agent_main, "get_codex_settings", lambda: {"model": "", "reasoning_effort": "medium", "system_prompt": "x", "command": "codex", "workdir": ".", "timeout_seconds": 30})
    monkeypatch.setattr(agent_main, "list_conversations", lambda **_kwargs: [{"id": "conversation-1", "codex_session_id": "old-thread", "codex_model": "gpt-5.6-sol", "codex_reasoning_effort": "low"}])
    monkeypatch.setattr(agent_main, "answer", fake_answer)
    monkeypatch.setattr(agent_main, "append_exchange", lambda **_kwargs: "conversation-1")
    monkeypatch.setattr(agent_main, "write_execution_log", lambda **_kwargs: None)
    monkeypatch.setattr(agent_main, "write_audit", lambda **_kwargs: None)

    response = TestClient(agent_main.app, base_url="http://localhost").post(
        "/api/v1/chat",
        json={"message": "hello", "conversation_id": "conversation-1", "model": "gpt-5.6-terra", "reasoning_effort": "medium"},
    )

    assert response.status_code == 200
    assert captured["session_id"] is None


def test_codex_passes_request_scoped_context_to_mcp(monkeypatch, tmp_path):
    captured = {}
    output_path = tmp_path / "result.txt"

    monkeypatch.setattr(codex_cli, "_command", lambda _value: "codex")
    monkeypatch.setattr(codex_cli, "_workdir", lambda _value: str(tmp_path))

    async def fake_create_subprocess(*command, **_kwargs):
        captured["command"] = command
        path = Path(command[command.index("--output-last-message") + 1])
        path.write_text("done", encoding="utf-8")
        return type("Process", (), {"returncode": 0})()

    async def fake_communicate(_process, _prompt):
        return "", ""

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess)
    monkeypatch.setattr(codex_cli, "_communicate", fake_communicate)
    monkeypatch.setattr(codex_cli.tempfile, "NamedTemporaryFile", lambda **_kwargs: type("Temp", (), {"name": str(output_path), "close": lambda self: None})())

    asyncio.run(codex_cli.answer(
        question="count servers", evidence=None,
        config={"command": "codex", "workdir": str(tmp_path), "reasoning_effort": "low", "timeout_seconds": 30},
        mcp_context={"CLOUDTOOL_MCP_EMAIL": "user@example.test", "CLOUDTOOL_MCP_PROJECT_ID": "project-1", "CLOUDTOOL_MCP_TOKEN": "token", "CLOUDTOOL_MCP_COOKIE": "cookie", "PYTHONPATH": str(tmp_path)},
    ))

    command = captured["command"]
    mcp_configs = [command[index + 1] for index, value in enumerate(command) if value == "--config" and "mcp_servers.cloudtool" in command[index + 1]]
    assert any(value.startswith("mcp_servers.cloudtool.command=") for value in mcp_configs)
    assert any(value.startswith("mcp_servers.cloudtool.env=") and "CLOUDTOOL_MCP_PROJECT_ID" in value for value in mcp_configs)


def test_mcp_tools_are_declared_read_only():
    assert mcp_server.TOOLS
    for tool in mcp_server.TOOLS:
        assert tool["annotations"]["readOnlyHint"] is True
        assert tool["annotations"]["destructiveHint"] is False


def test_codex_terminal_ticket_is_single_use(monkeypatch):
    monkeypatch.setattr(codex_terminal, "_tickets", {})
    ticket = codex_terminal.issue_ticket(
        actor_email="admin@example.test", project_id="project-1", command="codex", workdir=".",
    )

    granted = codex_terminal.take_ticket(ticket)

    assert granted is not None
    assert granted.actor_email == "admin@example.test"
    assert codex_terminal.take_ticket(ticket) is None


def test_csrf_refresh_returns_the_token_minted_by_cloudtool(monkeypatch):
    async def fake_caller(_request):
        return Caller("admin@example.test", "admin", "project-1", "cloud-token", "session-cookie", "fresh-csrf")

    monkeypatch.setattr(agent_main.gateway, "caller", fake_caller)
    client = TestClient(agent_main.app, base_url="http://localhost")

    response = client.post("/api/v1/csrf/refresh")

    assert response.status_code == 200
    assert response.json() == {"csrf_token": "fresh-csrf"}


def test_vm_action_is_strictly_parsed_and_removed_from_transcript():
    text = "Will inspect the VM.\n```cloudtool-vm-action\n{\"server\": \"server-01\", \"command\": \"free -h\", \"summary\": \"Kiểm tra RAM\"}\n```"

    assert extract_vm_action(text) == {"server": "server-01", "command": "free -h", "summary": "Kiểm tra RAM"}
    assert remove_vm_action_block(text) == "Will inspect the VM."
    assert extract_vm_action("```cloudtool-vm-action\n{\"command\": \"free -h\"}\n```") is None


def test_project_workspace_is_isolated_and_exposes_only_source_roots(monkeypatch, tmp_path):
    source = tmp_path / "repo"
    for relative in ("frontend/src", "backend/app", "agent-service/app"):
        (source / relative).mkdir(parents=True)
    monkeypatch.setattr(agent_main.settings, "CODEX_PROJECT_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setattr(agent_main.settings, "CODEX_SOURCE_ROOT", str(source))

    workspace = prepare_project_workspace("project-1")

    assert Path(workspace.path) == (tmp_path / "workspaces" / "project-1").resolve()
    assert (Path(workspace.path) / "PROJECT_CONTEXT.md").is_file()
    assert workspace.source_roots == [
        str((source / "frontend/src").resolve()),
        str((source / "backend/app").resolve()),
        str((source / "agent-service/app").resolve()),
    ]


def test_project_context_snapshot_is_split_into_redacted_project_files(monkeypatch, tmp_path):
    source = tmp_path / "repo"
    for relative in ("frontend/src", "backend/app", "agent-service/app"):
        (source / relative).mkdir(parents=True)
    monkeypatch.setattr(agent_main.settings, "CODEX_PROJECT_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setattr(agent_main.settings, "CODEX_SOURCE_ROOT", str(source))
    workspace = prepare_project_workspace("project-1")

    snapshot = write_project_context_snapshot(
        workspace,
        "project-1",
        {
            "inventory": {
                "items": [{
                    "id": "inventory-1",
                    "server_id": "server-1",
                    "server_name": "web-01",
                    "snapshot": {
                        "id": "server-1",
                        "name": "web-01",
                        "image": {"id": "image-1", "name": "Ubuntu"},
                        "key_pair": {"id": "key-1", "name": "main-key", "public_key": "not-needed"},
                        "user_data": "very large bootstrap payload",
                    },
                }]
            },
            "elastic_ips": {
                "items": [{
                    "id": "eip-1",
                    "ip_address": "203.0.113.10",
                    "server": {"id": "server-1", "name": "web-01", "display_name": "Web 01", "region": "unused"},
                    "project": "project-1",
                }]
            },
        },
    )

    assert "project-data/manifest.json" in snapshot.files
    inventory = json.loads((Path(workspace.path) / "project-data" / "server-inventory.json").read_text(encoding="utf-8"))
    assert inventory[0]["id"] == "server-1"
    assert inventory[0]["inventory_id"] == "inventory-1"
    assert inventory[0]["image"] == {"id": "image-1", "name": "Ubuntu"}
    assert inventory[0]["key_pair"] == {"id": "key-1", "name": "main-key"}
    assert "user_data" not in inventory[0]
    assert "snapshot" not in inventory[0]
    elastic_ips = json.loads((Path(workspace.path) / "project-data" / "elastic-ips.json").read_text(encoding="utf-8"))
    assert elastic_ips == [{"id": "eip-1", "ip": "203.0.113.10", "server": {"id": "server-1", "name": "web-01", "display_name": "Web 01"}}]


def test_project_context_refresh_endpoint_writes_current_project_workspace(monkeypatch, tmp_path):
    source = tmp_path / "repo"
    for relative in ("frontend/src", "backend/app", "agent-service/app"):
        (source / relative).mkdir(parents=True)
    monkeypatch.setattr(agent_main.settings, "CODEX_PROJECT_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setattr(agent_main.settings, "CODEX_SOURCE_ROOT", str(source))

    async def fake_caller(_request):
        return Caller("user@example.test", "operator", "project-1", "token", "cookie", "fresh-csrf")

    async def fake_collect(_caller, _question, _sources=None, *, snapshot=False):
        assert snapshot is True
        return {"inventory": {"items": [{"id": "server-1"}]}, "subnets": {"items": []}}, [{"source": "inventory", "count": 1}]

    monkeypatch.setattr(agent_main.gateway, "caller", fake_caller)
    monkeypatch.setattr(agent_main.gateway, "collect", fake_collect)
    monkeypatch.setattr(agent_main, "write_audit", lambda **_kwargs: None)

    response = TestClient(agent_main.app, base_url="http://localhost").post("/api/v1/project-context/refresh")

    assert response.status_code == 200
    assert response.json()["csrf_token"] == "fresh-csrf"
    assert (tmp_path / "workspaces" / "project-1" / "project-data" / "server-inventory.json").is_file()


def test_live_inventory_reads_each_current_server_detail_not_database_inventory(monkeypatch):
    gateway = CloudToolGateway()
    calls: list[str] = []

    async def fake_get(_client, _caller, path, _params=None):
        calls.append(path)
        if path == "/cloud/servers":
            return {"items": [{"id": "server-1"}, {"id": "server-2"}], "total": 2}
        if path == "/cloud/servers/server-1":
            return {"id": "server-1", "name": "live-web", "user_data": "omit"}
        if path == "/cloud/servers/server-2":
            return {"id": "server-2", "name": "live-db"}
        raise AssertionError(f"Unexpected API request: {path}")

    monkeypatch.setattr(gateway, "_get", fake_get)
    context, evidence = asyncio.run(gateway.collect(
        Caller("user@example.test", "operator", "project-1", "token", "cookie", "csrf"),
        "", {"inventory"}, snapshot=True,
    ))

    assert context["inventory"] == [
        {"id": "server-1", "name": "live-web", "user_data": "[REDACTED]"},
        {"id": "server-2", "name": "live-db"},
    ]
    assert "/cloud/server-inventory" not in calls
    assert {"/cloud/servers", "/cloud/servers/server-1", "/cloud/servers/server-2"} <= set(calls)
    assert evidence[-1] == {"source": "inventory", "count": 2, "note": "Live Cloud API server details"}


def test_security_group_rule_template_is_project_wide_excel_file(monkeypatch, tmp_path):
    from openpyxl import load_workbook

    source = tmp_path / "repo"
    for relative in ("frontend/src", "backend/app", "agent-service/app"):
        (source / relative).mkdir(parents=True)
    monkeypatch.setattr(agent_main.settings, "CODEX_PROJECT_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setattr(agent_main.settings, "CODEX_SOURCE_ROOT", str(source))
    workspace = prepare_project_workspace("project-1")

    relative_path = write_security_group_rule_template(workspace, "project-1", [
        {"id": "sg-1", "name": "app-sg", "display_name": "Application"},
        {"id": "sg-2", "name": "db-sg"},
    ])

    assert relative_path == "excel-template/security-group-multi-rules-template.xlsx"
    workbook = load_workbook(Path(workspace.path) / relative_path)
    sheet = workbook["Firewall Rules"]
    assert [sheet.cell(8, index).value for index in range(1, 8)] == [
        "SECURITY GROUP", "DIRECTION", "PROTOCOL", "PORT", "REMOTE IP PREFIX", "DESCRIPTION", "DELETE AT",
    ]
    assert sheet.cell(9, 1).value == "Application,db-sg"
    assert "Lists" in workbook.sheetnames
    assert workbook["Lists"].sheet_state == "hidden"


def test_workspace_attachment_is_saved_and_available_to_file_mentions(monkeypatch, tmp_path):
    source = tmp_path / "repo"
    for relative in ("frontend/src", "backend/app", "agent-service/app"):
        (source / relative).mkdir(parents=True)
    monkeypatch.setattr(agent_main.settings, "CODEX_PROJECT_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setattr(agent_main.settings, "CODEX_SOURCE_ROOT", str(source))
    workspace = prepare_project_workspace("project-1")

    stored = store_workspace_attachments(workspace, [{"name": "notes.md", "media_type": "text/markdown", "content_base64": base64.b64encode(b"# diagnostic notes").decode()}])

    assert stored[0]["path"].startswith("uploads/")
    assert workspace_files(workspace, "notes")[0]["path"] == stored[0]["path"]
    assert base64.b64decode(read_workspace_file(workspace, stored[0]["path"])["content_base64"]) == b"# diagnostic notes"
