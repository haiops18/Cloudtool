"""In-memory rendezvous for a Codex local tool call and a browser approval."""
from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from fastapi import HTTPException


@dataclass
class PendingAction:
    id: str
    capability: str
    conversation_id: str
    project_id: str
    actor_email: str
    action: dict
    status: str = "awaiting_approval"
    audit: list[dict] = field(default_factory=list)
    future: asyncio.Future = field(default_factory=lambda: asyncio.get_running_loop().create_future())
    expires_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc) + timedelta(minutes=5))

    def public(self) -> dict:
        return {"id": self.id, "conversation_id": self.conversation_id, "project_id": self.project_id,
                "action": self.action, "status": self.status, "audit": self.audit,
                "expires_at": self.expires_at.isoformat()}


class PendingActionBroker:
    def __init__(self):
        self._items: dict[str, PendingAction] = {}
        self._lock = asyncio.Lock()
        self._subscribers: dict[tuple[str, str, str], list[asyncio.Queue]] = {}

    async def create(self, conversation_id: str, project_id: str, actor_email: str, action: dict, timeout_seconds: int = 180) -> PendingAction:
        item = PendingAction(str(uuid4()), secrets.token_urlsafe(32), conversation_id, project_id, actor_email, action)
        item.expires_at = datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)
        item.audit.append({"at": datetime.now(timezone.utc).isoformat(), "status": "requested"})
        async with self._lock: self._items[item.id] = item
        return item

    async def get(self, action_id: str) -> PendingAction | None:
        async with self._lock: return self._items.get(action_id)

    async def claim(self, action_id: str, project_id: str, actor_email: str) -> PendingAction:
        """Only one decision may execute a pending mutation."""
        async with self._lock:
            item = self._items.get(action_id)
            if not item or (item.project_id, item.actor_email) != (project_id, actor_email):
                raise HTTPException(404, "Pending action not found")
            if item.status != "awaiting_approval" or item.future.done() or item.expires_at <= datetime.now(timezone.utc):
                raise HTTPException(409, "Pending action has expired or already received a decision")
            item.status = "deciding"
            return item

    async def discard(self, action_id: str) -> None:
        async with self._lock: self._items.pop(action_id, None)

    async def requested(self, capability_item: PendingAction, action: dict, timeout_seconds: int = 180) -> PendingAction:
        item = await self.create(capability_item.conversation_id, capability_item.project_id, capability_item.actor_email, action, timeout_seconds)
        item.capability = capability_item.capability
        return item

    async def list(self, conversation_id: str, project_id: str, actor_email: str) -> list[dict]:
        async with self._lock:
            return [x.public() for x in self._items.values() if x.conversation_id == conversation_id and x.project_id == project_id and x.actor_email == actor_email]

    def event(self, item: PendingAction, status: str) -> None:
        item.status = status; item.audit.append({"at": datetime.now(timezone.utc).isoformat(), "status": status})
        if item.action:
            # Delayed import prevents the broker from owning storage setup while
            # still ensuring timeout/reject/complete events are durable.
            from app.audit import record_api_action
            record_api_action(action_id=item.id, actor_email=item.actor_email, project_id=item.project_id,
                              conversation_id=item.conversation_id, action=item.action, status=item.status,
                              audit=item.audit, expires_at=item.expires_at.isoformat())
        key = (item.conversation_id, item.project_id, item.actor_email)
        for queue in self._subscribers.get(key, []): queue.put_nowait(item.public())

    async def subscribe(self, conversation_id: str, project_id: str, actor_email: str):
        key = (conversation_id, project_id, actor_email); queue: asyncio.Queue = asyncio.Queue()
        self._subscribers.setdefault(key, []).append(queue)
        try:
            while True: yield await queue.get()
        finally:
            subscribers = self._subscribers.get(key, [])
            if queue in subscribers: subscribers.remove(queue)

    async def wait(self, item: PendingAction) -> dict:
        try: return await asyncio.wait_for(asyncio.shield(item.future), max(0.1, (item.expires_at - datetime.now(timezone.utc)).total_seconds()))
        except asyncio.TimeoutError:
            if item.future.done():
                return item.future.result()
            if item.status in {"deciding", "approved", "executing"}:
                # Approval happened before expiry. A slow upstream write must
                # not be reported as a rejection while it may still complete.
                return await asyncio.shield(item.future)
            self.event(item, "timed_out")
            result = {"status": "rejected", "reason": "Approval timed out; user did not approve this action"}
            if not item.future.done(): item.future.set_result(result)
            if item.action:
                from app.audit import record_api_action
                record_api_action(action_id=item.id, actor_email=item.actor_email, project_id=item.project_id,
                                  conversation_id=item.conversation_id, action=item.action, status=item.status,
                                  audit=item.audit, expires_at=item.expires_at.isoformat(), result=result)
            return await item.future
        finally:
            async with self._lock: self._items.pop(item.id, None)

    def resolve(self, item: PendingAction, result: dict) -> None:
        if not item.future.done(): item.future.set_result(result)
