import asyncio

from app import codex_app_server
from app.execution_events import execution_event


def test_execution_events_only_expose_public_display_fields():
    assert execution_event("item/reasoning/textDelta", {"itemId": "reason", "delta": "private"}) is None
    event = execution_event("item/completed", {"item": {
        "id": "reason", "type": "reasoning", "summary": ["Checking the files"], "content": ["private"],
    }})
    assert event == {"item_id": "reason", "kind": "summary", "status": "complete", "text": "Checking the files"}
    event = execution_event("item/started", {"item": {
        "id": "tool", "type": "mcpToolCall", "server": "cloudtool", "tool": "list_servers",
        "arguments": {"token": "private"}, "result": {"token": "private"},
    }})
    assert event == {"item_id": "tool", "kind": "tool", "status": "running", "title": "cloudtool / list_servers"}


def test_turn_streams_commands_before_returning_the_same_final_answer(monkeypatch, tmp_path):
    events = []
    messages = [
        {"method": "item/commandExecution/outputDelta", "params": {"threadId": "other", "turnId": "turn", "itemId": "cmd", "delta": "other project"}},
        {"method": "item/commandExecution/outputDelta", "params": {"threadId": "thread", "turnId": "old-turn", "itemId": "cmd", "delta": "old turn"}},
        {"method": "item/commandExecution/outputDelta", "params": {"threadId": "thread", "turnId": "turn", "itemId": "cmd", "delta": "notes.txt\n"}},
        {"method": "item/completed", "params": {"threadId": "thread", "turnId": "turn", "item": {"id": "cmd", "type": "commandExecution", "command": "rg --files", "status": "completed", "aggregatedOutput": "notes.txt\n", "exitCode": 0}}},
        {"method": "item/completed", "params": {"threadId": "thread", "turnId": "turn", "item": {"id": "answer", "type": "agentMessage", "text": "Final answer"}}},
        {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed", "items": []}}},
    ]

    async def rpc(method, params, **kwargs):
        assert method == "turn/start"
        assert params["model"] == "test-model"
        assert params["effort"] == "high"
        assert params["approvalPolicy"] == "never"
        kwargs["notifications"].append({"method": "item/started", "params": {
            "threadId": "thread", "turnId": "turn", "item": {"id": "cmd", "type": "commandExecution", "command": "rg --files", "cwd": str(tmp_path)},
        }})
        return {"turn": {"id": "turn"}}

    async def next_message(_timeout):
        return messages.pop(0)

    async def report(event):
        events.append(event)

    monkeypatch.setattr(codex_app_server, "_rpc", rpc)
    monkeypatch.setattr(codex_app_server, "_next_message", next_message)
    config = {"workdir": str(tmp_path), "model": "test-model", "reasoning_effort": "high", "timeout_seconds": 30}
    result = asyncio.run(codex_app_server._run_turn("thread", "Question", config, None, execution_reporter=report))
    assert result == "Final answer"
    assert [event["kind"] for event in events] == ["command", "command", "command", "message"]
    assert events[0]["command"] == "rg --files"
    assert events[1]["delta"] == "notes.txt\n"
    assert events[2]["output"] == "notes.txt\n"
    assert events[2]["exit_code"] == 0


def test_display_observer_failure_does_not_fail_the_turn(monkeypatch, tmp_path):
    async def rpc(*_args, **_kwargs):
        return {"turn": {"id": "turn"}}

    messages = [
        {"method": "item/completed", "params": {"threadId": "thread", "item": {"id": "answer", "type": "agentMessage", "text": "Answer"}}},
        {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed"}}},
    ]

    async def next_message(_timeout):
        return messages.pop(0)

    async def report(_event):
        raise RuntimeError("Display is unavailable")

    monkeypatch.setattr(codex_app_server, "_rpc", rpc)
    monkeypatch.setattr(codex_app_server, "_next_message", next_message)
    config = {"workdir": str(tmp_path), "timeout_seconds": 30}
    assert asyncio.run(codex_app_server._run_turn("thread", "Question", config, None, execution_reporter=report)) == "Answer"


def test_chat_sse_forwards_live_execution_before_the_final_response(monkeypatch):
    from app import main
    from app.schemas import ChatRequest, ChatResponse

    async def caller(_request):
        return None

    async def chat(payload, _request, report):
        await report("codex_event", {"request_id": payload.request_id, "item_id": "cmd", "kind": "command", "command": "rg --files", "status": "running"})
        await report("codex_event", {"request_id": payload.request_id, "item_id": "cmd", "kind": "command", "field": "output", "delta": "notes.txt\n"})
        return ChatResponse(request_id=payload.request_id, conversation_id="conversation", answer="Answer", evidence=[], mode="codex-app-server")

    monkeypatch.setattr(main.gateway, "caller", caller)
    monkeypatch.setattr(main, "chat", chat)

    async def collect():
        response = await main.chat_stream(ChatRequest(message="Question", request_id="request"), None)
        return [chunk async for chunk in response.body_iterator]

    chunks = asyncio.run(collect())
    assert [chunk.splitlines()[0] for chunk in chunks] == [
        "event: started", "event: codex_event", "event: codex_event", "event: completed",
    ]
    assert "rg --files" in chunks[1]
    assert "notes.txt" in chunks[2]
    assert '"answer": "Answer"' in chunks[3]


def test_execution_observer_preserves_dynamic_tool_handler_and_response(monkeypatch, tmp_path):
    responses = []
    calls = []
    messages = [
        {"id": 17, "method": "item/tool/call", "params": {"threadId": "thread", "turnId": "turn", "tool": "create_security_group_rule", "arguments": {"group": "app"}}},
        {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed", "items": [{"type": "agentMessage", "text": "Action result"}]}}},
    ]

    async def rpc(*_args, **_kwargs):
        return {"turn": {"id": "turn"}}

    async def next_message(_timeout):
        return messages.pop(0)

    async def respond(identifier, result):
        responses.append((identifier, result))

    async def tool(name, arguments):
        calls.append((name, arguments))
        return {"status": "success"}

    async def report(_event):
        pass

    monkeypatch.setattr(codex_app_server, "_rpc", rpc)
    monkeypatch.setattr(codex_app_server, "_next_message", next_message)
    monkeypatch.setattr(codex_app_server, "_respond", respond)
    config = {"workdir": str(tmp_path), "timeout_seconds": 30}
    assert asyncio.run(codex_app_server._run_turn("thread", "Question", config, None, tool, report)) == "Action result"
    assert calls == [("create_security_group_rule", {"group": "app"})]
    assert responses == [(17, {"success": True, "contentItems": [{"type": "inputText", "text": '{"status": "success"}'}]})]
