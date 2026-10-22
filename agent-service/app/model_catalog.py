from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from app.codex_cli import CodexCliError, _command, _workdir


class CodexModelCatalogError(RuntimeError):
    """The locally authenticated Codex app-server did not provide a catalog."""


def configured_model_fallback(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Keep chat usable while the local app-server catalog is temporarily unavailable.

    This is intentionally derived only from the administrator's saved runtime
    selection; it never invents a cloud model or sends a request elsewhere.
    """
    model = str(config.get("model") or "").strip() or "codex-default"
    effort = str(config.get("reasoning_effort") or "medium")
    efforts = ["low", "medium", "high", "xhigh", "max", "ultra"]
    return [{
        "id": model,
        "display_name": model if model != "codex-default" else "Codex default",
        "description": "Saved local Codex selection (live catalog is temporarily unavailable).",
        "is_default": True,
        "reasoning_efforts": efforts,
        "default_reasoning_effort": effort if effort in efforts else "medium",
    }]


async def codex_model_catalog(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the authenticated Codex account's model picker data.

    ``codex exec`` deliberately has no ``models`` subcommand. The local
    app-server does, and is the same protocol used by the Codex VS Code
    extension. There is intentionally no static fallback: showing a model not
    offered by the signed-in Codex account is worse than showing no picker.
    """
    process: asyncio.subprocess.Process | None = None
    try:
        command = _command(str(config["command"]))
        process = await asyncio.create_subprocess_exec(
            command, "app-server", "--stdio",
            cwd=_workdir(str(config["workdir"])),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **({"creationflags": 0x08000000} if os.name == "nt" else {}),
        )
        if process.stdin is None or process.stdout is None:
            raise CodexCliError("Codex app-server pipes could not be created")

        def request(identifier: int | None, method: str, params: dict[str, Any]) -> None:
            payload: dict[str, Any] = {"method": method, "params": params}
            if identifier is not None:
                payload["id"] = identifier
            process.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))

        request(1, "initialize", {"clientInfo": {"name": "cloudtool-agent-service", "version": "1.0"}, "capabilities": {}})
        await process.stdin.drain()
        # Wait for initialization; notifications can appear before or after it.
        for _ in range(5):
            line = await asyncio.wait_for(process.stdout.readline(), timeout=5)
            if not line:
                raise CodexCliError("Codex app-server exited during initialization")
            if json.loads(line).get("id") == 1:
                break
        else:
            raise CodexCliError("Codex app-server did not initialize")

        request(None, "initialized", {})
        request(2, "model/list", {})
        await process.stdin.drain()
        response: dict[str, Any] | None = None
        for _ in range(10):
            line = await asyncio.wait_for(process.stdout.readline(), timeout=5)
            if not line:
                break
            candidate = json.loads(line)
            if candidate.get("id") == 2:
                response = candidate
                break
        raw_models = (response or {}).get("result", {}).get("data", [])
        models: list[dict[str, Any]] = []
        for raw in raw_models:
            model_id = str(raw.get("model") or raw.get("id") or "").strip()
            efforts = [str(item.get("reasoningEffort")) for item in raw.get("supportedReasoningEfforts", []) if item.get("reasoningEffort")]
            if not model_id or not efforts or raw.get("hidden"):
                continue
            default_effort = str(raw.get("defaultReasoningEffort") or efforts[0])
            models.append({
                "id": model_id,
                "display_name": str(raw.get("displayName") or model_id),
                "description": str(raw.get("description") or "Codex model available to the signed-in account."),
                "is_default": bool(raw.get("isDefault")),
                "reasoning_efforts": efforts,
                "default_reasoning_effort": default_effort if default_effort in efforts else efforts[0],
            })
        if not models:
            raise CodexModelCatalogError("Codex app-server returned no selectable models")
        return models
    except CodexModelCatalogError:
        raise
    except (CodexCliError, OSError, asyncio.TimeoutError, json.JSONDecodeError, NotImplementedError) as exc:
        raise CodexModelCatalogError(f"Could not retrieve the model list from Codex: {exc}") from exc
    finally:
        if process:
            if process.stdin and not process.stdin.is_closing():
                process.stdin.close()
                try:
                    await asyncio.wait_for(process.stdin.wait_closed(), timeout=1)
                except (asyncio.TimeoutError, BrokenPipeError):
                    pass
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=3)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            # Drain the remaining pipes before the event loop is disposed. On
            # Windows this prevents Proactor transport resource warnings.
            if process.stdout:
                await process.stdout.read()
            if process.stderr:
                await process.stderr.read()


async def validate_model_selection(config: dict[str, Any]) -> None:
    """Resolve and validate every requested model/effort against Codex itself."""
    try:
        models = await codex_model_catalog(config)
    except CodexModelCatalogError:
        # The actual app-server call remains authoritative at turn start. Do
        # not fail a chat solely because its optional picker catalog timed out.
        return
    requested_model = str(config.get("model") or "").strip()
    selected = next((item for item in models if item["id"] == requested_model), None)
    if selected is None:
        selected = next((item for item in models if item["is_default"]), None) or models[0]
        if requested_model:
            raise CodexModelCatalogError(f"Selected Codex model is not available: {requested_model}")
        config["model"] = selected["id"]
    effort = str(config.get("reasoning_effort") or "").strip()
    if effort not in selected["reasoning_efforts"]:
        raise CodexModelCatalogError(
            f"Reasoning effort '{effort}' is not supported by {selected['display_name']}"
        )
