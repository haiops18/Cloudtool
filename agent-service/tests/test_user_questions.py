import asyncio

import httpx
import pytest
from fastapi import HTTPException

from app import codex_app_server, main
from app.gateway import Caller
from app.user_questions import QuestionAnswers, UserQuestionBroker


PAYLOAD = {"questions": [{"id": "zone", "header": "Zone", "question": "Chọn zone nào?",
                          "isOther": False, "options": [{"label": "zone-a (id-a)", "description": "Region A"},
                                                        {"label": "zone-b (id-b)", "description": "Region B"}]}]}


async def wait_for_question(broker):
    for _ in range(20):
        if broker.items:
            return next(iter(broker.items))
        await asyncio.sleep(0)
    raise AssertionError("Question was not published")


def test_question_waits_for_explicit_answer_and_is_project_user_scoped():
    async def run():
        broker = UserQuestionBroker()
        task = asyncio.create_task(broker.ask(conversation_id="c", project_id="p", actor_email="a", request_id="r", payload=PAYLOAD))
        identifier = await wait_for_question(broker)
        assert not task.done()
        assert not broker.list("c", "other-project", "a")
        assert not broker.list("c", "p", "other-user")
        answer = QuestionAnswers(answers={"zone": ["zone-b (id-b)"]})
        with pytest.raises(HTTPException) as denied:
            broker.answer(identifier, "other-project", "a", answer)
        assert denied.value.status_code == 404
        with pytest.raises(HTTPException):
            broker.answer(identifier, "p", "a", QuestionAnswers(answers={"zone": ["guessed-zone"]}))
        assert not task.done()
        broker.answer(identifier, "p", "a", answer)
        with pytest.raises(HTTPException) as duplicate:
            broker.answer(identifier, "p", "a", answer)
        assert duplicate.value.status_code == 409
        assert await task == {"answers": {"zone": {"answers": ["zone-b (id-b)"]}}}
        assert not broker.items
    asyncio.run(run())


def test_cancel_timeout_and_disconnection_never_select_defaults():
    async def run():
        broker = UserQuestionBroker()
        kwargs = dict(conversation_id="c", project_id="p", actor_email="a", request_id="r", payload=PAYLOAD)
        task = asyncio.create_task(broker.ask(**kwargs))
        await wait_for_question(broker)
        broker.cancel_request("r", "p", "a")
        assert await task == {"answers": {}}
        assert await broker.ask(**kwargs, timeout_seconds=0.001) == {"answers": {}}
        task = asyncio.create_task(broker.ask(**kwargs))
        await wait_for_question(broker)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not broker.items
    asyncio.run(run())


def test_question_http_roundtrip(monkeypatch):
    async def run():
        broker = UserQuestionBroker()
        monkeypatch.setattr(main, "user_questions", broker)
        async def caller(request):
            return Caller("a", "operator", request.headers.get("x-project-id", "p"), "t", "c", "csrf")
        monkeypatch.setattr(main.gateway, "caller", caller)
        task = asyncio.create_task(broker.ask(conversation_id="chat", project_id="p", actor_email="a", request_id="r", payload=PAYLOAD))
        identifier = await wait_for_question(broker)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://localhost") as client:
            response = await client.get("/api/v1/conversations/chat/questions")
            assert response.json()["items"][0]["questions"][0]["id"] == "zone"
            route = f"/api/v1/questions/{identifier}/answer"
            denied = await client.post(route, headers={"x-project-id": "other"}, json={"cancel": True})
            assert denied.status_code == 404
            response = await client.post(route, json={"answers": {"zone": ["zone-a (id-a)"]}})
            assert response.status_code == 200
        assert await task == {"answers": {"zone": {"answers": ["zone-a (id-a)"]}}}
    asyncio.run(run())


def test_native_codex_question_resumes_same_turn(monkeypatch, tmp_path):
    messages = [
        {"id": 42, "method": "item/tool/requestUserInput", "params": {"threadId": "thread", "turnId": "turn", **PAYLOAD}},
        {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed", "items": [{"type": "agentMessage", "text": "Selected zone B"}]}}},
    ]
    responses = []
    async def rpc(*args, **kwargs):
        return {"turn": {"id": "turn"}}
    async def next_message(timeout):
        return messages.pop(0)
    async def respond(identifier, result):
        responses.append((identifier, result))
    async def handler(name, arguments):
        assert name == "ask_user_question" and arguments == PAYLOAD
        return {"answers": {"zone": {"answers": ["zone-b (id-b)"]}}}
    monkeypatch.setattr(codex_app_server, "_rpc", rpc)
    monkeypatch.setattr(codex_app_server, "_next_message", next_message)
    monkeypatch.setattr(codex_app_server, "_respond", respond)
    result = asyncio.run(codex_app_server._run_turn("thread", "Create VM", {"workdir": str(tmp_path), "timeout_seconds": 30}, None, handler))
    assert result == "Selected zone B"
    assert responses == [(42, {"answers": {"zone": {"answers": ["zone-b (id-b)"]}}})]


def test_default_mode_question_feature_is_enabled_only_for_project_chat():
    assert codex_app_server._thread_config({}, {"project": "p"})["features.default_mode_request_user_input"]
    assert "features.default_mode_request_user_input" not in codex_app_server._thread_config({}, None)
