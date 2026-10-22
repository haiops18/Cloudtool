"""Conversation-scoped rendezvous for Codex clarification requests."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator


class QuestionOption(BaseModel):
    model_config = ConfigDict(extra="ignore")
    label: str = Field(min_length=1, max_length=500)
    description: str = Field(default="", max_length=2000)


class UserQuestion(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=1, max_length=160)
    header: str = Field(default="Question", max_length=160)
    question: str = Field(min_length=1, max_length=4000)
    options: list[QuestionOption] | None = Field(default=None, max_length=100)
    isOther: bool = True
    isSecret: bool = False


class UserQuestions(BaseModel):
    questions: list[UserQuestion] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def validate_questions(self):
        if len({q.id for q in self.questions}) != len(self.questions):
            raise ValueError("Question IDs must be unique")
        if any(q.isSecret for q in self.questions):
            raise ValueError("Do not request passwords or credentials through chat clarification")
        return self


class QuestionAnswers(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answers: dict[str, list[str]] = Field(default_factory=dict, max_length=3)
    cancel: bool = False


@dataclass
class PendingQuestion:
    id: str
    conversation_id: str
    project_id: str
    actor_email: str
    request_id: str
    questions: UserQuestions
    future: asyncio.Future
    expires_at: datetime

    def public(self):
        return {"id": self.id, "conversation_id": self.conversation_id,
                "questions": self.questions.model_dump()["questions"],
                "expires_at": self.expires_at.isoformat()}


class UserQuestionBroker:
    def __init__(self):
        self.items: dict[str, PendingQuestion] = {}

    async def ask(self, *, conversation_id: str, project_id: str, actor_email: str,
                  request_id: str, payload: dict, timeout_seconds: float = 900) -> dict:
        questions = UserQuestions.model_validate(payload)
        item = PendingQuestion(str(uuid4()), conversation_id, project_id, actor_email,
                               request_id, questions, asyncio.get_running_loop().create_future(),
                               datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds))
        self.items[item.id] = item
        try:
            return await asyncio.wait_for(asyncio.shield(item.future), timeout_seconds)
        except asyncio.TimeoutError:
            # Empty answers mean unanswered, never a default choice or permission.
            return {"answers": {}}
        finally:
            self.items.pop(item.id, None)
            if not item.future.done():
                item.future.cancel()

    def list(self, conversation_id: str, project_id: str, actor_email: str):
        return [item.public() for item in self.items.values()
                if (item.conversation_id, item.project_id, item.actor_email) ==
                (conversation_id, project_id, actor_email) and not item.future.done()]

    def answer(self, identifier: str, project_id: str, actor_email: str, payload: QuestionAnswers):
        item = self.items.get(identifier)
        if not item or (item.project_id, item.actor_email) != (project_id, actor_email):
            raise HTTPException(404, "Question not found in this project and user session")
        if item.future.done() or item.expires_at <= datetime.now(timezone.utc):
            raise HTTPException(409, "Question is no longer awaiting an answer")
        result = {}
        if not payload.cancel:
            if set(payload.answers) != {q.id for q in item.questions.questions}:
                raise HTTPException(422, "Answer every question in this request")
            for q in item.questions.questions:
                answers = payload.answers[q.id]
                if len(answers) != 1 or not answers[0].strip() or len(answers[0]) > 4000:
                    raise HTTPException(422, "Each question requires one non-empty answer")
                value = answers[0].strip()
                if q.options and not q.isOther and value not in {o.label for o in q.options}:
                    raise HTTPException(422, "Select one of the supplied options")
                result[q.id] = {"answers": [value]}
        item.future.set_result({"answers": result})

    def cancel_request(self, request_id: str, project_id: str, actor_email: str):
        for item in list(self.items.values()):
            if (item.request_id, item.project_id, item.actor_email) == (request_id, project_id, actor_email):
                if not item.future.done():
                    item.future.set_result({"answers": {}})
