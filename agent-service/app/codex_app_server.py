from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

from app.codex_cli import CodexCliError, _command, _workdir, prompt_preview
from app.execution_events import execution_event
from app.user_questions import UserQuestions
from app.project_actions import project_tool_definitions


class CodexAppServerError(RuntimeError):
    pass


class CodexSessionUnavailableError(CodexAppServerError):
    """The persisted Codex thread ID was explicitly rejected by app-server."""


_lock = asyncio.Lock()
_process: asyncio.subprocess.Process | None = None
_next_request_id = 0
_active_requests: dict[str, asyncio.subprocess.Process] = {}
_dynamic_tool_threads: set[str] = set()

DynamicToolHandler = Callable[[str, Any], Awaitable[dict[str, Any]]]
ExecutionReporter = Callable[[dict[str, Any]], Awaitable[None]]


def _pending_api_tools(enabled: bool) -> list[dict[str, Any]] | None:
    """Expose the write gateway as an app-server API tool, never as MCP/shell."""
    if not enabled:
        return None
    return [{
        "type": "function",
        "name": "create_security_group_rule",
        "description": (
            "Create one or multiple CloudTool security-group firewall rules for the same group through the local "
            "approval gateway. This waits for browser approval and returns the real "
            "success, rejected, or failed JSON. Use only after an exact group ID is known."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "security_group_id": {"type": "string"},
                "rules": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object"}},
            },
            "required": ["security_group_id", "rules"],
            "additionalProperties": False,
        },
    }, {
        "type": "function",
        "name": "create_vm_deployment",
        "description": (
            "Queue one or more CloudTool VM servers through the local approval gateway. "
            "It returns an accepted deployment ID and poll URL, not a false claim that VMs are already ready."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"deployment": {"type": "object"}},
            "required": ["deployment"],
            "additionalProperties": False,
        },
    }, {
        "type": "function", "name": "ask_user_question",
        "description": "Ask the user 1-3 required clarification questions and wait for their answers in chat. For VM selections, first look up real choices, include exact names/IDs in option labels, and never guess. Empty answers mean cancelled/unanswered; do not choose a default. Prefer native request_user_input when available.",
        "inputSchema": UserQuestions.model_json_schema(),
    }] + project_tool_definitions()


async def _stop_process() -> None:
    global _process
    process, _process = _process, None
    if process is None or process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=3)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


async def _start(config: dict[str, Any]) -> asyncio.subprocess.Process:
    global _process, _next_request_id
    if _process and _process.returncode is None:
        return _process
    command = _command(str(config["command"]))
    _process = await asyncio.create_subprocess_exec(
        command, "app-server", "--stdio",
        cwd=_workdir(str(config["workdir"])),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        # A repaired thread/list page can include enough metadata to exceed
        # asyncio's 64 KiB readline default.  App-server is line-delimited
        # JSON-RPC, so retain a bounded but practical per-message ceiling.
        limit=16 * 1024 * 1024,
        **({"creationflags": 0x08000000} if os.name == "nt" else {}),
    )
    _next_request_id = 0
    await _rpc(
        "initialize",
        {
            "clientInfo": {"name": "cloudtool-agent-service", "version": "1.0"},
            # runtimeWorkspaceRoots is required for the read-only sandbox and
            # is explicitly guarded by this capability in current Codex.
            "capabilities": {"experimentalApi": True},
        },
    )
    await _notify("initialized", {})
    return _process


async def _notify(method: str, params: dict[str, Any]) -> None:
    if _process is None or _process.stdin is None:
        raise CodexAppServerError("Codex app-server is not running")
    _process.stdin.write((json.dumps({"method": method, "params": params}) + "\n").encode("utf-8"))
    await _process.stdin.drain()


async def _next_message(timeout: float) -> dict[str, Any]:
    if _process is None or _process.stdout is None:
        raise CodexAppServerError("Codex app-server is not running")
    line = await asyncio.wait_for(_process.stdout.readline(), timeout=timeout)
    if not line:
        raise CodexAppServerError("Codex app-server exited unexpectedly")
    try:
        return json.loads(line)
    except json.JSONDecodeError as exc:
        raise CodexAppServerError("Codex app-server returned invalid JSON-RPC") from exc


async def _rpc(method: str, params: dict[str, Any], timeout: float = 20, notifications: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    global _next_request_id
    if _process is None or _process.stdin is None:
        raise CodexAppServerError("Codex app-server is not running")
    _next_request_id += 1
    identifier = _next_request_id
    _process.stdin.write((json.dumps({"id": identifier, "method": method, "params": params}) + "\n").encode("utf-8"))
    await _process.stdin.drain()
    while True:
        message = await _next_message(timeout)
        if message.get("id") != identifier:
            if notifications is not None and message.get("method"):
                notifications.append(message)
            continue
        if "error" in message:
            raise CodexAppServerError(str(message["error"].get("message") or "Codex app-server request failed"))
        return message.get("result") or {}


def _thread_config(config: dict[str, Any], mcp_context: dict[str, str] | None) -> dict[str, Any]:
    values: dict[str, Any] = {"model_reasoning_effort": str(config.get("reasoning_effort") or "medium")}
    if mcp_context:
        # The app-server accepts the same dotted configuration keys as Codex.
        # Keeping this per-thread means project credentials are never written
        # into the host-wide Codex configuration.
        values.update({
            "features.default_mode_request_user_input": True,
            "mcp_servers.cloudtool.command": sys.executable,
            "mcp_servers.cloudtool.args": ["-m", "app.mcp_server"],
            "mcp_servers.cloudtool.env": mcp_context,
        })
    return values


def _runtime_workspace_roots(config: dict[str, Any]) -> list[str]:
    """Validate the explicit read-only code roots sent to Codex app-server."""
    roots: list[str] = []
    for value in config.get("runtime_workspace_roots") or []:
        path = Path(str(value)).expanduser().resolve()
        if path.is_dir():
            roots.append(str(path))
    return roots


async def _start_thread(config: dict[str, Any], mcp_context: dict[str, str] | None, dynamic_tool_handler: DynamicToolHandler | None = None) -> tuple[str, str | None]:
    model = str(config.get("model") or "").strip() or None
    result = await _rpc(
        "thread/start",
        {
            "model": model,
            "modelProvider": None,
            "cwd": _workdir(str(config["workdir"])),
            "approvalPolicy": "never",
            "permissions": "cloudtool-artifact-write",
            "runtimeWorkspaceRoots": _runtime_workspace_roots(config),
            "config": _thread_config(config, mcp_context),
            "personality": None,
            "ephemeral": False,
            "threadSource": "user",
            "experimentalRawEvents": False,
            "dynamicTools": _pending_api_tools(dynamic_tool_handler is not None),
            "serviceTier": None,
        },
    )
    thread = result.get("thread") or {}
    thread_id = str(thread.get("id") or "")
    if not thread_id:
        raise CodexAppServerError("Codex app-server did not return a thread ID")
    if dynamic_tool_handler is not None:
        _dynamic_tool_threads.add(thread_id)
    selected_model = str(result.get("model") or model or "") or None
    # Never let an app-server default silently replace the choice displayed in
    # the UI. A caller can retry after refreshing its live Codex model catalog.
    if model and selected_model != model:
        raise CodexAppServerError(f"Codex selected '{selected_model or 'unknown'}' instead of requested model '{model}'")
    return thread_id, selected_model


async def _resume_thread(thread_id: str, config: dict[str, Any], mcp_context: dict[str, str] | None, dynamic_tool_handler: DynamicToolHandler | None = None) -> tuple[str, str | None]:
    """Hydrate a durable rollout from Codex's local state DB before a turn.

    A fresh app-server process does not know a thread merely because its ID is
    supplied to ``turn/start``. ``thread/resume`` is the protocol operation
    that loads the persisted rollout by ID (the same model used by clients
    that reopen historical threads).
    """
    result = await _rpc(
        "thread/resume",
        {
            "threadId": thread_id,
            "cwd": _workdir(str(config["workdir"])),
            "approvalPolicy": "never",
            # Model and effort are overridden by the following ``turn/start``
            # request. Keeping resume neutral preserves the existing thread
            # and all of its context.
            "model": None,
            "modelProvider": None,
            "config": _thread_config(config, mcp_context),
            "personality": None,
            "serviceTier": None,
            "excludeTurns": True,
        },
    )
    thread = result.get("thread") or {}
    resumed_id = str(thread.get("id") or thread_id)
    if dynamic_tool_handler is not None:
        _dynamic_tool_threads.add(resumed_id)
    selected_model = str(result.get("model") or config.get("model") or "") or None
    return resumed_id, selected_model


def _user_item_text(content: object) -> str:
    """Extract the readable portion of an app-server userMessage item."""
    if not isinstance(content, list):
        return ""
    pieces: list[str] = []
    for part in content:
        if isinstance(part, str):
            pieces.append(part)
        elif isinstance(part, dict):
            text = part.get("text")
            if isinstance(text, str):
                pieces.append(text)
    return "\n".join(piece for piece in pieces if piece.strip()).strip()


def _strip_turn_wrapper(text: str) -> str:
    """Remove the stored per-turn instruction wrapper from visible text."""
    start, end = "<CURRENT_TURN>", "</CURRENT_TURN>"
    if start in text and end in text:
        return text.split(start, 1)[1].split(end, 1)[0].strip()
    return text


def _history_user_message(content: object) -> str:
    return _strip_turn_wrapper(_user_item_text(content))


def _thread_list_title(item: dict[str, Any]) -> str:
    """Choose a compact title from thread/list metadata only.

    ``preview`` is supplied with each list row by Codex (normally its first
    user message), so this must never trigger a per-thread ``thread/read``.
    """
    name = str(item.get("name") or "").strip()
    if name and name.casefold() not in {"untitled", "untitled codex chat"}:
        return name
    preview = _strip_turn_wrapper(str(item.get("preview") or ""))
    compact = " ".join(preview.split())
    if compact:
        return compact[:96].rstrip() + ("…" if len(compact) > 96 else "")
    return "Untitled Codex chat"


def _history_items(thread: dict[str, Any]) -> list[dict[str, str]]:
    """Map Codex rollout items into UI-safe transcript rows.

    This deliberately reads only the actual user and agent messages held by
    Codex. Tool payloads can contain implementation details and are neither
    needed nor appropriate for a chat-history viewer.
    """
    rows: list[dict[str, str]] = []
    for turn in thread.get("turns") or []:
        if not isinstance(turn, dict):
            continue
        for item in turn.get("items") or []:
            if not isinstance(item, dict):
                continue
            kind = item.get("type")
            if kind == "userMessage":
                text = _history_user_message(item.get("content"))
                role = "user"
            elif kind == "agentMessage":
                text = str(item.get("text") or "").strip()
                role = "assistant"
            else:
                continue
            if text:
                rows.append({"id": str(item.get("id") or uuid4()), "role": role, "text": text})
    return rows


async def list_history_threads(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Return every durable Codex thread whose cwd is this project workspace.

    No Agent Service conversation or message table is consulted.  The exact
    cwd filter is the ownership boundary: it prevents this project view from
    exposing threads opened in another project or elsewhere on the machine.
    """
    try:
        workdir = _workdir(str(config["workdir"]))
        async with _lock:
            await _start(config)
            cursor: str | None = None
            threads: list[dict[str, Any]] = []
            while True:
                result = await _rpc("thread/list", {
                    "cwd": workdir,
                    "cursor": cursor,
                    "limit": 100,
                    "archived": None,
                    "sortDirection": "desc",
                    "useStateDbOnly": False,
                }, timeout=45)
                page = result.get("data") or []
                threads.extend(item for item in page if isinstance(item, dict))
                next_cursor = result.get("nextCursor")
                if not next_cursor or next_cursor == cursor:
                    break
                cursor = str(next_cursor)
    except (CodexCliError, OSError, asyncio.TimeoutError) as exc:
        raise CodexAppServerError(f"Codex chat history is unavailable: {exc}") from exc
    return [{
            "id": str(item.get("id") or ""),
            "title": _thread_list_title(item),
            "created_at": item.get("createdAt"),
            "updated_at": item.get("updatedAt"),
        } for item in threads if item.get("id")]


async def read_history_thread(thread_id: str, config: dict[str, Any]) -> dict[str, Any]:
    """Read one Codex-owned rollout and verify its cwd before returning it."""
    try:
        workdir = _workdir(str(config["workdir"]))
        async with _lock:
            await _start(config)
            result = await _rpc("thread/read", {"threadId": thread_id, "includeTurns": True}, timeout=60)
    except (CodexCliError, OSError, asyncio.TimeoutError) as exc:
        raise CodexAppServerError(f"Codex chat history is unavailable: {exc}") from exc
    thread = result.get("thread") or {}
    if not isinstance(thread, dict) or str(thread.get("cwd") or "") != workdir:
        # A direct thread ID must never become a way to inspect a host-wide
        # Codex conversation belonging to another workspace.
        raise CodexAppServerError("Codex thread is not available in this project workspace")
    return {
        "id": str(thread.get("id") or thread_id),
        "title": str(thread.get("name") or "Untitled Codex chat"),
        "created_at": thread.get("createdAt"),
        "updated_at": thread.get("updatedAt"),
        "messages": _history_items(thread),
    }


async def _respond(identifier: Any, result: dict[str, Any]) -> None:
    if _process is None or _process.stdin is None:
        raise CodexAppServerError("Codex app-server is not running")
    _process.stdin.write((json.dumps({"id": identifier, "result": result}) + "\n").encode("utf-8"))
    await _process.stdin.drain()


async def _run_turn(thread_id: str, prompt: str, config: dict[str, Any], request_id: str | None, dynamic_tool_handler: DynamicToolHandler | None = None, execution_reporter: ExecutionReporter | None = None) -> str:
    workdir = _workdir(str(config["workdir"]))
    model = str(config.get("model") or "").strip() or None
    effort = str(config.get("reasoning_effort") or "").strip() or None
    notifications: list[dict[str, Any]] = []
    result = await _rpc(
        "turn/start",
        {
            "threadId": thread_id,
            "turnTrigger": "user",
            "clientUserMessageId": str(uuid4()),
            "input": [{"type": "text", "text": prompt, "text_elements": []}],
            "cwd": workdir,
            "approvalPolicy": "never",
            "permissions": "cloudtool-artifact-write",
            "runtimeWorkspaceRoots": _runtime_workspace_roots(config),
            # These are per-thread overrides.  Unlike starting a new thread,
            # they preserve the current conversation and take effect for this
            # and subsequent turns, matching the Codex editor behaviour.
            "model": model,
            "effort": effort,
            "serviceTier": None,
            "summary": "auto",
            "personality": None,
            "outputSchema": None,
            "collaborationMode": None,
        },
        timeout=20,
        notifications=notifications,
    )
    turn_id = str((result.get("turn") or {}).get("id") or "")
    if not turn_id:
        raise CodexAppServerError("Codex app-server did not start a turn")
    final_text = ""
    timeout_seconds = int(config["timeout_seconds"])
    while True:
        if request_id and request_id not in _active_requests:
            raise CodexAppServerError("Codex request was cancelled")
        message = notifications.pop(0) if notifications else await _next_message(timeout_seconds)
        params = message.get("params") or {}
        if message.get("method") in {"item/tool/requestUserInput", "tool/requestUserInput"}:
            if params.get("threadId") != thread_id or params.get("turnId", turn_id) != turn_id:
                continue
            result = {"answers": {}}
            if dynamic_tool_handler is not None:
                try:
                    result = await dynamic_tool_handler("ask_user_question", {"questions": params.get("questions", [])})
                except asyncio.CancelledError:
                    await _stop_process()
                    raise
                except ValueError:
                    # Reject invalid/secret prompts without leaving a native
                    # server request hanging or manufacturing a user answer.
                    pass
            await _respond(message.get("id"), result)
            continue
        if (
            execution_reporter and params.get("threadId") == thread_id
            and params.get("turnId", turn_id) == turn_id
        ):
            try:
                event = execution_event(str(message.get("method") or ""), params)
                if event:
                    await execution_reporter(event)
            except Exception:
                # A display-only observer must never fail a Codex turn.
                pass
        if message.get("method") == "item/tool/call":
            if dynamic_tool_handler is None:
                await _respond(message.get("id"), {"success": False, "contentItems": [{"type": "inputText", "text": "This API action is unavailable for this turn."}]})
                continue
            try:
                result = await dynamic_tool_handler(str(params.get("tool") or ""), params.get("arguments"))
                await _respond(message.get("id"), {"success": True, "contentItems": [{"type": "inputText", "text": json.dumps(result, ensure_ascii=False)}]})
            except asyncio.CancelledError:
                if params.get("tool") == "ask_user_question":
                    await _stop_process()
                raise
            except Exception as exc:  # Return a structured tool error so Codex can explain it safely.
                await _respond(message.get("id"), {"success": False, "contentItems": [{"type": "inputText", "text": json.dumps({"status": "failed", "reason": str(exc)}, ensure_ascii=False)}]})
            continue
        if params.get("threadId") != thread_id:
            continue
        if message.get("method") == "item/completed":
            item = params.get("item") or {}
            if item.get("type") == "agentMessage" and item.get("text"):
                final_text = str(item["text"])
        if message.get("method") == "turn/completed":
            turn = params.get("turn") or {}
            if str(turn.get("id")) != turn_id:
                continue
            if turn.get("status") != "completed":
                detail = (turn.get("error") or {}).get("message") or turn.get("status")
                raise CodexAppServerError(f"Codex turn failed: {detail}")
            for item in turn.get("items") or []:
                if item.get("type") == "agentMessage" and item.get("text"):
                    final_text = str(item["text"])
            if not final_text.strip():
                raise CodexAppServerError("Codex app-server returned an empty answer")
            return final_text.strip()


async def cancel(request_id: str) -> bool:
    """Cancel the current app-server turn without leaving a hidden process."""
    process = _active_requests.pop(request_id, None)
    if process is None:
        return False
    # Calls are serialized; terminating the active app-server precisely mirrors
    # the old `codex exec` cancellation semantics. The next request starts a
    # clean app-server and safely creates a new thread if needed.
    await _stop_process()
    return True


async def answer(*, question: str, evidence: dict[str, Any] | None, config: dict[str, Any], attachments: list[dict[str, str]] | None = None, session_id: str | None = None, request_id: str | None = None, mcp_context: dict[str, str] | None = None, dynamic_tool_handler: DynamicToolHandler | None = None, execution_reporter: ExecutionReporter | None = None) -> tuple[str, str | None, str | None]:
    prompt = prompt_preview(question, evidence, attachments, str(config.get("system_prompt") or ""), mcp_available=bool(mcp_context))
    requested_model = str(config.get("model") or "").strip() or None
    async with _lock:
        await _start(config)
        if request_id:
            _active_requests[request_id] = _process  # type: ignore[assignment]
        try:
            # Persisted app-server thread IDs are the source of truth. Do not
            # require this process to have created the thread: Codex can
            # restore a durable thread after Agent Service/host restart.
            can_resume = bool(session_id)
            thread_id, selected_model = await _resume_thread(session_id, config, mcp_context, dynamic_tool_handler) if can_resume else await _start_thread(config, mcp_context, dynamic_tool_handler)
            try:
                text = await _run_turn(thread_id, prompt, config, request_id, dynamic_tool_handler, execution_reporter)
            except CodexAppServerError as exc:
                # Threads live in the app-server process. After a controlled
                # restart, recreate only the missing conversation thread.
                if session_id and "thread not found" in str(exc).lower():
                    raise CodexSessionUnavailableError("The saved Codex conversation no longer exists") from exc
                else:
                    raise
            # ``turn/start`` receives the explicit per-thread override.  A
            # resumed thread can report its prior model during resume, so the
            # requested override is the authoritative value for this log and
            # for the model reported back to the chat UI.
            return text, requested_model or selected_model or "codex-app-server", thread_id
        except asyncio.TimeoutError as exc:
            raise CodexAppServerError("Codex app-server timed out") from exc
        finally:
            if request_id:
                _active_requests.pop(request_id, None)
