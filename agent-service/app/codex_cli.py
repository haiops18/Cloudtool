from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from app.config import get_settings

settings = get_settings()
_lock = asyncio.Semaphore(1)
_processes: dict[str, asyncio.subprocess.Process] = {}
# Keep the runtime instruction deliberately short.  A full policy document in
# the user prompt made Codex start an unnecessary exploratory agent turn before
# answering.  The service itself enforces the policy through its allow-list and
# read-only sandbox; this instruction tells the model to answer from the
# already-collected evidence immediately.
DEFAULT_RUNTIME_CONTEXT = """You are CloudTool's read-only diagnostic assistant.
Answer in Vietnamese. Use CloudTool MCP only for current project facts; retrieve the smallest useful data.
Never execute shell commands, access local files, browse the web, request credentials, or perform write actions yourself.
Tool guide: search_servers(query) finds servers; use search_servers() with an empty query for the exact server count; get_server_details(id) gets one server; get_inventory() gets inventory; list_subnets() gets networking; list_security_groups() gets network policy; get_audit_events() gets audit history; get_cloud_api_history() gets Cloud API history. Search first, then request details only when needed.
All MCP tools are read-only. If data is insufficient, say so. Give observed facts, likely causes, and safe next checks."""




class CodexCliError(RuntimeError):
    pass


def prompt_preview(question: str, evidence: dict[str, Any] | None = None, attachments: list[dict[str, str]] | None = None, system_prompt: str | None = None, mcp_available: bool = False) -> str:
    """Return the textual input supplied to Codex, suitable for an audit log.

    Images are supplied to the CLI separately, so the preview records their
    metadata rather than storing binary data or temporary host paths.
    """
    attachment_text: list[str] = []
    for attachment in attachments or []:
        name = Path(attachment["name"]).name
        media_type = attachment["media_type"]
        if media_type.startswith("image/"):
            attachment_text.append(f"\n--- Image attachment supplied to Codex: {name} ({media_type}) ---")
            continue
        try:
            raw = base64.b64decode(attachment["content_base64"], validate=True)
            content = raw.decode("utf-8", errors="replace")[:20000]
        except (KeyError, ValueError):
            content = "[Attachment could not be decoded]"
        attachment_text.append(f"\n--- Untrusted attachment: {name} ---\n{content}\n--- End attachment ---")
    context = f"\n[PRELOADED_EVIDENCE]\n{json.dumps(evidence, ensure_ascii=False)}\n[/PRELOADED_EVIDENCE]" if evidence else ""
    return f"{system_prompt or DEFAULT_RUNTIME_CONTEXT}\n\n<CURRENT_TURN>\n{question.strip()}\n</CURRENT_TURN>{context}{''.join(attachment_text)}"


def _command(value: str) -> str:
    command = value.strip()
    name = Path(command).name.lower()
    if name not in {"codex", "codex.exe", "codex.cmd", "codex.bat"}:
        raise CodexCliError("Codex command must be the codex executable")
    if Path(command).is_absolute() and not Path(command).is_file():
        raise CodexCliError("Configured Codex executable was not found")
    if Path(command).is_absolute():
        return command
    resolved = shutil.which(command)
    if not resolved:
        raise CodexCliError("Codex CLI is not available on the agent-service PATH")
    # Windows CreateProcess does not expand a bare `codex` to codex.cmd.
    return resolved


def _workdir(value: str) -> str:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise CodexCliError("Configured Codex working directory was not found")
    return str(path)


async def status(config: dict[str, Any]) -> dict[str, Any]:
    try:
        command = _command(str(config["command"]))
        process = await asyncio.to_thread(
            subprocess.run,
            [command, "--version"],
            capture_output=True,
            cwd=_workdir(str(config["workdir"])),
            text=True,
            timeout=10,
            check=False,
        )
        return {
            "available": process.returncode == 0,
            "version": process.stdout.strip()[:200] or None,
        }
    except (CodexCliError, OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "version": None, "error": str(exc)}


async def cancel(request_id: str) -> bool:
    """Stop a currently-running local Codex request, if it still exists."""
    process = _processes.get(request_id)
    if process is None or process.returncode is not None:
        return False
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=3)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
    return True


async def _communicate(process: asyncio.subprocess.Process, prompt: str) -> tuple[str, str]:
    if process.stdin is None or process.stdout is None or process.stderr is None:
        raise CodexCliError("Codex CLI pipes could not be created")
    process.stdin.write(prompt.encode("utf-8"))
    await process.stdin.drain()
    process.stdin.close()
    stdout_task = asyncio.create_task(process.stdout.read())
    stderr_task = asyncio.create_task(process.stderr.read())
    await process.wait()
    stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
    return stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")


async def answer(*, question: str, evidence: dict[str, Any] | None, config: dict[str, Any], attachments: list[dict[str, str]] | None = None, session_id: str | None = None, request_id: str | None = None, mcp_context: dict[str, str] | None = None) -> tuple[str, str | None, str | None]:
    command = _command(str(config["command"]))
    system_prompt = str(config.get("system_prompt") or DEFAULT_RUNTIME_CONTEXT).strip()
    workdir = _workdir(str(config["workdir"]))
    text_attachments: list[str] = []
    image_paths: list[str] = []
    temporary_paths: list[Path] = []
    for attachment in attachments or []:
        raw = base64.b64decode(attachment["content_base64"], validate=True)
        if len(raw) > 2 * 1024 * 1024:
            raise CodexCliError("Attachment exceeds the 2 MB limit")
        media_type = attachment["media_type"]
        safe_name = Path(attachment["name"]).name
        if media_type.startswith("image/"):
            suffix = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[media_type]
            handle = tempfile.NamedTemporaryFile(prefix="cloudtool-upload-", suffix=suffix, delete=False)
            handle.write(raw)
            handle.close()
            path = Path(handle.name)
            temporary_paths.append(path)
            image_paths.append(str(path))
        else:
            text_attachments.append(f"\n--- Untrusted attachment: {safe_name} ---\n{raw.decode('utf-8', errors='replace')[:20000]}\n--- End attachment ---")
    context = f"\n\nEvidence JSON (only preloaded context):\n{json.dumps(evidence, ensure_ascii=False)}" if evidence else ""
    prompt = f"{system_prompt}\n\nQuestion:\n{question}{context}{''.join(text_attachments)}"
    output = tempfile.NamedTemporaryFile(prefix="cloudtool-codex-", suffix=".txt", delete=False)
    output.close()
    # Global options must precede ``exec``.  Subcommand options (notably
    # ``--image`` for ``exec resume``) follow their subcommand.  The previous
    # implementation replaced ``--json`` with ``resume`` and produced an
    # invalid resume command on current Codex CLI versions.
    args = [
        command,
        "--ask-for-approval", "never",
        "--sandbox", "read-only",
    ]
    model = str(config.get("model") or "").strip()
    reasoning_effort = str(config.get("reasoning_effort") or "medium")
    args[1:1] = ["--config", f'model_reasoning_effort="{reasoning_effort}"']
    if model:
        args[1:1] = ["--model", model]
    if mcp_context:
        args[1:1] = ["--config", f"mcp_servers.cloudtool.command={json.dumps(sys.executable)}"]
        args[1:1] = ["--config", 'mcp_servers.cloudtool.args=["-m", "app.mcp_server"]']
        mcp_environment = ", ".join(f"{key} = {json.dumps(value)}" for key, value in mcp_context.items())
        args[1:1] = ["--config", f"mcp_servers.cloudtool.env={{ {mcp_environment} }}"]
    args.extend(["exec"])
    if session_id:
        args.extend(["resume", "--json", "--skip-git-repo-check", "--output-last-message", output.name])
        for image_path in image_paths:
            args.extend(["--image", image_path])
        args.extend([session_id, "-"])
    else:
        args.extend(["--json", "--skip-git-repo-check", "--output-last-message", output.name])
        for image_path in image_paths:
            args.extend(["--image", image_path])
        args.append("-")
    try:
        async with _lock:
            process = await asyncio.create_subprocess_exec(
                *args,
                cwd=workdir,
                env={**os.environ, "CODEX_ASK_FOR_APPROVAL": "never", **(mcp_context or {})},
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                **({"creationflags": 0x08000000} if os.name == "nt" else {}),
            )
            if request_id:
                _processes[request_id] = process
            try:
                try:
                    stdout, stderr = await asyncio.wait_for(
                        _communicate(process, prompt), timeout=int(config["timeout_seconds"])
                    )
                except asyncio.TimeoutError:
                    if request_id:
                        await cancel(request_id)
                    elif process.returncode is None:
                        process.kill()
                        await process.wait()
                    raise
            finally:
                if request_id:
                    _processes.pop(request_id, None)
        text = Path(output.name).read_text(encoding="utf-8", errors="replace").strip()
        if process.returncode != 0 or not text:
            detail = stderr.strip().splitlines()[-1:] or ["No response from Codex CLI"]
            raise CodexCliError(detail[0][:300])
        thread_id = session_id
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
                if event.get("type") == "thread.started":
                    thread_id = event.get("thread_id") or thread_id
            except json.JSONDecodeError:
                continue
        return text, model or "codex-cli", thread_id
    except asyncio.TimeoutError as exc:
        raise CodexCliError("Codex CLI timed out") from exc
    finally:
        Path(output.name).unlink(missing_ok=True)
        for path in temporary_paths:
            path.unlink(missing_ok=True)
