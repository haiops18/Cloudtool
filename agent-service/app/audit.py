import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from app.security import redact

DB_PATH = Path(__file__).resolve().parents[2] / "data" / "agent-service.db"


def _connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS agent_audit_log (
            id TEXT PRIMARY KEY, created_at TEXT NOT NULL, actor_email TEXT,
            project_id TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL,
            metadata_json TEXT NOT NULL
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS agent_execution_log (
            id TEXT PRIMARY KEY, created_at TEXT NOT NULL, actor_email TEXT NOT NULL,
            project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, request_id TEXT NOT NULL,
            status TEXT NOT NULL, model TEXT, reasoning_effort TEXT, mode TEXT NOT NULL,
            user_input TEXT NOT NULL, prompt_text TEXT NOT NULL, context_json TEXT NOT NULL,
            answer_text TEXT NOT NULL, activity_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
            duration_ms INTEGER NOT NULL
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS agent_api_action_log (
            id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            actor_email TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
            action_json TEXT NOT NULL, status TEXT NOT NULL, audit_json TEXT NOT NULL,
            result_json TEXT NOT NULL DEFAULT '{}', expires_at TEXT
        )"""
    )
    conn.row_factory = sqlite3.Row
    return conn


def write_audit(*, actor_email: str, project_id: str, action: str, result: str, metadata: dict) -> None:
    conn = _connection()
    try:
        conn.execute(
            "INSERT INTO agent_audit_log VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid4()),
                datetime.now(timezone(timedelta(hours=7), name="GMT+7")).isoformat(),
                actor_email,
                project_id,
                action,
                result,
                json.dumps(redact(metadata), ensure_ascii=False),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def write_execution_log(*, actor_email: str, project_id: str, conversation_id: str, request_id: str,
                        status: str, model: str | None, reasoning_effort: str, mode: str,
                        user_input: str, prompt_text: str, context: dict, answer_text: str,
                        activity: list[dict], metadata: dict, duration_ms: int) -> None:
    """Persist a bounded, redacted diagnostic record for an internal chat run."""
    conn = _connection()
    try:
        conn.execute(
            "INSERT INTO agent_execution_log VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid4()), datetime.now(timezone(timedelta(hours=7), name="GMT+7")).isoformat(),
                actor_email, project_id, conversation_id, request_id, status, model, reasoning_effort,
                mode, redact(user_input), redact(prompt_text), json.dumps(redact(context), ensure_ascii=False),
                redact(answer_text), json.dumps(redact(activity), ensure_ascii=False),
                json.dumps(redact(metadata), ensure_ascii=False), duration_ms,
            ),
        )
        conn.commit()
    finally:
        conn.close()


_EXECUTION_LOG_SUMMARY = "id, created_at, actor_email, project_id, conversation_id, request_id, status, model, reasoning_effort, mode, user_input, answer_text, duration_ms"


def list_execution_logs(*, project_id: str, limit: int = 25, offset: int = 0) -> tuple[list[dict], int]:
    """Return a small page only; full prompts/context are fetched on demand."""
    conn = _connection()
    try:
        rows = conn.execute(
            f"SELECT {_EXECUTION_LOG_SUMMARY} FROM agent_execution_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (project_id, max(1, min(limit, 100)), max(0, offset)),
        ).fetchall()
        total = int(conn.execute("SELECT COUNT(*) FROM agent_execution_log WHERE project_id = ?", (project_id,)).fetchone()[0])
        return ([{key: row[key] for key in row.keys()} for row in rows], total)
    finally:
        conn.close()


def get_execution_log(*, project_id: str, log_id: str) -> dict | None:
    conn = _connection()
    try:
        row = conn.execute("SELECT * FROM agent_execution_log WHERE project_id = ? AND id = ?", (project_id, log_id)).fetchone()
        if not row:
            return None
        return {
            **{key: row[key] for key in ("id", "created_at", "actor_email", "project_id", "conversation_id", "request_id", "status", "model", "reasoning_effort", "mode", "user_input", "prompt_text", "answer_text", "duration_ms")},
            "context": json.loads(row["context_json"]),
            "activity": json.loads(row["activity_json"]),
            "metadata": json.loads(row["metadata_json"]),
        }
    finally:
        conn.close()


def delete_execution_logs_before(*, project_id: str, before: str) -> int:
    conn = _connection()
    try:
        cursor = conn.execute("DELETE FROM agent_execution_log WHERE project_id = ? AND created_at < ?", (project_id, before))
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def record_api_action(*, action_id: str, actor_email: str, project_id: str, conversation_id: str,
                      action: dict, status: str, audit: list[dict], expires_at: str | None,
                      result: dict | None = None) -> None:
    """Persist a redacted approval lifecycle; action ID makes repeated events an update."""
    conn = _connection()
    try:
        now = datetime.now(timezone(timedelta(hours=7), name="GMT+7")).isoformat()
        conn.execute(
            """INSERT INTO agent_api_action_log
               (id, created_at, updated_at, actor_email, project_id, conversation_id, action_json, status, audit_json, result_json, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, status=excluded.status,
               audit_json=excluded.audit_json, result_json=excluded.result_json, expires_at=excluded.expires_at""",
            (action_id, now, now, actor_email, project_id, conversation_id,
             json.dumps(redact(action), ensure_ascii=False), status,
             json.dumps(redact(audit), ensure_ascii=False), json.dumps(redact(result or {}), ensure_ascii=False), expires_at),
        )
        conn.commit()
    finally:
        conn.close()


def list_api_action_logs(*, project_id: str, actor_email: str, limit: int = 50) -> list[dict]:
    conn = _connection()
    try:
        rows = conn.execute(
            "SELECT * FROM agent_api_action_log WHERE project_id=? AND actor_email=? ORDER BY updated_at DESC LIMIT ?",
            (project_id, actor_email, max(1, min(limit, 100))),
        ).fetchall()
        return [{**{key: row[key] for key in ("id", "created_at", "updated_at", "conversation_id", "status", "expires_at")},
                 "action": json.loads(row["action_json"]), "audit": json.loads(row["audit_json"]),
                 "result": json.loads(row["result_json"])} for row in rows]
    finally:
        conn.close()


def get_api_action_log(*, project_id: str, actor_email: str, action_id: str) -> dict | None:
    return next((item for item in list_api_action_logs(project_id=project_id, actor_email=actor_email, limit=100)
                 if item["id"] == action_id), None)
