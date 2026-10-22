from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from app.config import get_settings

DB_PATH = Path(__file__).resolve().parents[2] / "data" / "agent-service.db"


def defaults() -> dict[str, Any]:
    settings = get_settings()
    return {
        "provider": settings.AGENT_LLM_PROVIDER,
        "command": settings.CODEX_COMMAND,
        "model": settings.CODEX_MODEL or "",
        "reasoning_effort": settings.CODEX_REASONING_EFFORT,
        "workdir": settings.CODEX_WORKDIR,
        "timeout_seconds": settings.CODEX_TIMEOUT_SECONDS,
        "approval_timeout_seconds": settings.PENDING_ACTION_TIMEOUT_SECONDS,
        "system_prompt": settings.CODEX_SYSTEM_PROMPT,
        "workspace_prompt": "@path refers to that exact project-workspace file; read it when relevant. Attachments are under uploads/. Project `{project_id}`: read only PROJECT_CONTEXT.md, project-data/, uploads/, api-docs/, and supplied source roots. For a user-requested deliverable, write only under outputs/; never modify input data, templates, source files, secrets, or any other path.",
        "project_chat_prompt": "Use read-only MCP for current CloudTool facts and project-data only when useful. For SG rules or VM creation, read the matching api-docs guide, use the native action API, and wait for approval; never use MCP, shell, direct HTTP, or credentials for writes. VM deployments may be queued, not ready. For VM console diagnostics, identify the server first and emit a cloudtool-vm-action block only for a safe, explicit command.",
    }


def _connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("CREATE TABLE IF NOT EXISTS agent_runtime_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)")
    return conn


def get_codex_settings() -> dict[str, Any]:
    values = defaults()
    conn = _connection()
    try:
        row = conn.execute("SELECT value_json FROM agent_runtime_settings WHERE key = 'codex'").fetchone()
        if row:
            saved = json.loads(row[0])
            values.update({key: saved[key] for key in values if key in saved})
    finally:
        conn.close()
    # Migrate previous CLI-exec configuration to the app-server transport.
    if values["provider"] in {"openai", "codex_cli"}:
        values["provider"] = "codex_app_server"
    return values


def save_codex_settings(values: dict[str, Any]) -> dict[str, Any]:
    merged = defaults()
    merged.update(values)
    conn = _connection()
    try:
        conn.execute(
            "INSERT INTO agent_runtime_settings(key, value_json) VALUES('codex', ?) "
            "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            (json.dumps(merged),),
        )
        conn.commit()
        return merged
    finally:
        conn.close()
