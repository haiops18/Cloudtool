"""Authenticated browser bridge for an interactive local Codex CLI session.

This is deliberately *not* a host shell endpoint.  It starts exactly the
configured ``codex`` executable in a Windows pseudo-terminal, so the browser
can use Codex's own interactive approval flow and terminal UI.
"""
from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from time import monotonic
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, WebSocket, WebSocketDisconnect

# The AI chat path uses Codex app-server and must remain available even when a
# deployment intentionally omits the optional Windows terminal bridge.
try:
    from winpty import PtyProcess
except ModuleNotFoundError:
    PtyProcess = None  # type: ignore[assignment,misc]

from app.audit import write_audit
from app.codex_cli import _command, _workdir


@dataclass
class TerminalTicket:
    actor_email: str
    project_id: str
    command: str
    workdir: str
    expires_at: float


_tickets: dict[str, TerminalTicket] = {}


def terminal_bridge_available() -> bool:
    return PtyProcess is not None


def issue_ticket(*, actor_email: str, project_id: str, command: str, workdir: str) -> str:
    now = monotonic()
    for value in [key for key, ticket in _tickets.items() if ticket.expires_at <= now]:
        _tickets.pop(value, None)
    token = str(uuid4())
    _tickets[token] = TerminalTicket(actor_email, project_id, command, workdir, now + 60)
    return token


def take_ticket(token: str) -> TerminalTicket | None:
    ticket = _tickets.pop(token, None)
    return ticket if ticket and ticket.expires_at > monotonic() else None


def _origin_allowed(origin: str | None, allowed_origins: list[str]) -> bool:
    # WebSocket is not covered by FastAPI's CORS middleware.  The short-lived,
    # single-use ticket is the primary credential; Origin is a second browser
    # boundary that protects it from cross-site use.
    return bool(origin and origin.rstrip("/") in {value.rstrip("/") for value in allowed_origins})


async def run_terminal(websocket: WebSocket, ticket: TerminalTicket, allowed_origins: list[str]) -> None:
    if not _origin_allowed(websocket.headers.get("origin"), allowed_origins):
        await websocket.close(code=1008, reason="Untrusted browser origin")
        return

    # Accept before spawning the pseudo-terminal.  The prior implementation
    # accepted only after a global lock and a blocking Windows spawn, leaving
    # browsers indefinitely in the WebSocket "connecting" state.
    await websocket.accept()
    if not terminal_bridge_available():
        await websocket.send_json({"type": "error", "message": "Direct Codex terminal requires pywinpty. Install agent-service requirements in the Python environment that runs this service."})
        await websocket.close(code=1011, reason="pywinpty is not installed")
        return
    await websocket.send_json({"type": "status", "state": "starting", "message": "Starting local Codex CLI…"})
    try:
        executable = _command(ticket.command)
        workdir = _workdir(ticket.workdir)
        process = await asyncio.to_thread(
            PtyProcess.spawn, [executable], cwd=workdir, env=dict(os.environ), dimensions=(30, 120)
        )
    except Exception as exc:
        write_audit(actor_email=ticket.actor_email, project_id=ticket.project_id, action="agent.codex_terminal.start", result="failed", metadata={"error": str(exc)[:200]})
        await websocket.send_json({"type": "error", "message": "Could not start local Codex CLI"})
        await websocket.close(code=1011, reason="Could not start Codex CLI")
        return

    try:
        write_audit(actor_email=ticket.actor_email, project_id=ticket.project_id, action="agent.codex_terminal.start", result="success", metadata={"workdir": workdir})
        await websocket.send_json({"type": "status", "state": "ready", "message": "Codex CLI is ready"})

        async def forward_output() -> None:
            while process.isalive():
                try:
                    output = await asyncio.to_thread(process.read, 4096)
                except EOFError:
                    return
                if output:
                    await websocket.send_json({"type": "output", "data": output})

        async def forward_input() -> None:
            while True:
                message: dict[str, Any] = await websocket.receive_json()
                message_type = message.get("type")
                if message_type == "input":
                    value = message.get("data")
                    if not isinstance(value, str) or len(value) > 16_384:
                        await websocket.send_json({"type": "error", "message": "Invalid terminal input"})
                        continue
                    await asyncio.to_thread(process.write, value)
                elif message_type == "resize":
                    cols, rows = message.get("cols"), message.get("rows")
                    if isinstance(cols, int) and isinstance(rows, int):
                        await asyncio.to_thread(process.setwinsize, max(20, min(cols, 300)), max(8, min(rows, 120)))
                elif message_type == "close":
                    return

        output_task = asyncio.create_task(forward_output())
        input_task = asyncio.create_task(forward_input())
        try:
            done, pending = await asyncio.wait({output_task, input_task}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                task.result()
        except WebSocketDisconnect:
            pass
        finally:
            if process.isalive():
                await asyncio.to_thread(process.terminate)
            write_audit(actor_email=ticket.actor_email, project_id=ticket.project_id, action="agent.codex_terminal.stop", result="success", metadata={"exit_status": process.exitstatus})
    finally:
        # The nested session block owns process cleanup; this outer boundary
        # keeps startup/audit failures from escaping the WebSocket handler.
        pass
