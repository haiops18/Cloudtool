"""Public execution details from Codex notifications, without raw protocol data."""
from typing import Any


def execution_event(method: str, params: dict[str, Any]) -> dict[str, Any] | None:
    if method == "item/reasoning/summaryPartAdded" and params.get("itemId") and params.get("summaryIndex", 0) > 0:
        return {"item_id": str(params["itemId"]), "kind": "summary", "field": "text", "delta": "\n\n"}
    deltas = {
        "item/commandExecution/outputDelta": ("command", "output"),
        "item/agentMessage/delta": ("message", "text"),
        "item/plan/delta": ("plan", "text"),
        "item/reasoning/summaryTextDelta": ("summary", "text"),
    }
    if method in deltas:
        kind, field = deltas[method]
        if not params.get("itemId") or not isinstance(params.get("delta"), str):
            return None
        return {"item_id": str(params["itemId"]), "kind": kind, "field": field, "delta": params["delta"]}
    if method not in {"item/started", "item/completed"}:
        return None
    item = params.get("item") or {}
    kinds = {
        "commandExecution": "command", "agentMessage": "message", "plan": "plan",
        "reasoning": "summary", "mcpToolCall": "tool", "dynamicToolCall": "tool",
        "fileChange": "files", "webSearch": "search", "imageView": "image",
    }
    kind = kinds.get(item.get("type"))
    if not kind or not item.get("id"):
        return None
    status = "running" if method == "item/started" else "complete"
    if item.get("status") in {"failed", "declined"} or item.get("success") is False:
        status = "failed"
    event: dict[str, Any] = {"item_id": str(item["id"]), "kind": kind, "status": status}
    for source, target in (("command", "command"), ("cwd", "cwd"), ("text", "text"), ("aggregatedOutput", "output"), ("phase", "phase")):
        if isinstance(item.get(source), str):
            # Final snapshots replace deltas, and stay bounded in the browser.
            event[target] = item[source][-64000:]
    if isinstance(item.get("exitCode"), int):
        event["exit_code"] = item["exitCode"]
    if kind == "summary" and item.get("summary"):
        event["text"] = "\n\n".join(str(part) for part in item["summary"])[-64000:]
    if kind == "tool":
        event["title"] = " / ".join(str(item[key]) for key in ("server", "tool") if item.get(key))
    if kind == "files":
        event["text"] = "\n".join(str(change.get("path") or "") for change in item.get("changes") or [])[-64000:]
    if kind == "search":
        event["text"] = str(item.get("query") or (item.get("action") or {}).get("url") or "")
    if kind == "image":
        event["text"] = str(item.get("path") or "")
    # Raw reasoning, credentials, MCP configuration and tool arguments/results
    # are intentionally not part of this display-only stream.
    return event
