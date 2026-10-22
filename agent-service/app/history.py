from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

DB_PATH = Path(__file__).resolve().parents[2] / "data" / "agent-service.db"


def _now() -> str:
    return datetime.now(timezone(timedelta(hours=7), name="GMT+7")).isoformat()


def _connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE IF NOT EXISTS agent_conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, actor_email TEXT NOT NULL, title TEXT NOT NULL, updated_at TEXT NOT NULL, codex_session_id TEXT, codex_model TEXT, codex_reasoning_effort TEXT, skill_ids_json TEXT NOT NULL DEFAULT '[]')")
    columns = {row[1] for row in conn.execute("PRAGMA table_info(agent_conversations)")}
    if "codex_session_id" not in columns:
        conn.execute("ALTER TABLE agent_conversations ADD COLUMN codex_session_id TEXT")
    if "codex_model" not in columns:
        conn.execute("ALTER TABLE agent_conversations ADD COLUMN codex_model TEXT")
    if "codex_reasoning_effort" not in columns:
        conn.execute("ALTER TABLE agent_conversations ADD COLUMN codex_reasoning_effort TEXT")
    if "skill_ids_json" not in columns:
        conn.execute("ALTER TABLE agent_conversations ADD COLUMN skill_ids_json TEXT NOT NULL DEFAULT '[]'")
    conn.execute("CREATE TABLE IF NOT EXISTS agent_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL)")
    message_columns = {row[1] for row in conn.execute("PRAGMA table_info(agent_messages)")}
    if "attachments_json" not in message_columns:
        conn.execute("ALTER TABLE agent_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'")
    return conn


def append_exchange(*, project_id: str, actor_email: str, conversation_id: str, question: str, answer: str, evidence: list[dict], attachments: list[dict] | None = None, artifacts: list[dict] | None = None, codex_session_id: str | None, codex_model: str, codex_reasoning_effort: str, skill_ids: list[str] | None = None) -> str:
    conn = _connection()
    try:
        existing = conn.execute(
            "SELECT id FROM agent_conversations WHERE id = ? AND project_id = ? AND actor_email = ?",
            (conversation_id, project_id, actor_email),
        ).fetchone()
        identifier = conversation_id if existing else str(uuid4())
        title = question.strip().replace("\n", " ")[:80] or "File analysis"
        now = _now()
        if existing:
            conn.execute(
                "UPDATE agent_conversations SET updated_at = ?, codex_session_id = ?, codex_model = ?, codex_reasoning_effort = ?, skill_ids_json = ? WHERE id = ? AND actor_email = ?",
                (now, codex_session_id, codex_model, codex_reasoning_effort, json.dumps(skill_ids or []), identifier, actor_email),
            )
        else:
            conn.execute("INSERT INTO agent_conversations(id, project_id, actor_email, title, updated_at, codex_session_id, codex_model, codex_reasoning_effort, skill_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (identifier, project_id, actor_email, title, now, codex_session_id, codex_model, codex_reasoning_effort, json.dumps(skill_ids or [])))
        for role, text, items, attached in (("user", question, [], attachments or []), ("assistant", answer, evidence, artifacts or [])):
            conn.execute("INSERT INTO agent_messages (id, conversation_id, role, text, evidence_json, created_at, attachments_json) VALUES (?, ?, ?, ?, ?, ?, ?)", (str(uuid4()), identifier, role, text, json.dumps(items, ensure_ascii=False), now, json.dumps(attached, ensure_ascii=False)))
        conn.commit()
        return identifier
    finally:
        conn.close()


def append_agent_continuation(*, project_id: str, actor_email: str, conversation_id: str, answer: str, evidence: list[dict], codex_session_id: str | None, codex_model: str, codex_reasoning_effort: str) -> str:
    """Persist the assistant follow-up without exposing a gateway tool result as user chat."""
    conn = _connection()
    try:
        existing = conn.execute(
            "SELECT id FROM agent_conversations WHERE id = ? AND project_id = ? AND actor_email = ?",
            (conversation_id, project_id, actor_email),
        ).fetchone()
        if not existing:
            raise ValueError("Conversation was not found")
        now = _now()
        conn.execute(
            "UPDATE agent_conversations SET updated_at = ?, codex_session_id = ?, codex_model = ?, codex_reasoning_effort = ? WHERE id = ? AND actor_email = ?",
            (now, codex_session_id, codex_model, codex_reasoning_effort, conversation_id, actor_email),
        )
        conn.execute(
            "INSERT INTO agent_messages (id, conversation_id, role, text, evidence_json, created_at, attachments_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (str(uuid4()), conversation_id, "assistant", answer, json.dumps(evidence, ensure_ascii=False), now, "[]"),
        )
        conn.commit()
        return conversation_id
    finally:
        conn.close()


def list_conversations(*, project_id: str, actor_email: str, limit: int = 100, offset: int = 0) -> list[dict]:
    conn = _connection()
    try:
        rows = conn.execute("SELECT id, title, updated_at, codex_session_id, codex_model, codex_reasoning_effort, skill_ids_json FROM agent_conversations WHERE project_id = ? AND actor_email = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?", (project_id, actor_email, limit, offset)).fetchall()
        results: list[dict] = []
        for row in rows:
            results.append({
                "id": row["id"], "title": row["title"], "updated_at": row["updated_at"], "codex_session_id": row["codex_session_id"],
                "codex_model": row["codex_model"], "codex_reasoning_effort": row["codex_reasoning_effort"],
                "skill_ids": json.loads(row["skill_ids_json"] or "[]"),
                "messages": [],
            })
        return results
    finally:
        conn.close()


def get_conversation(*, project_id: str, actor_email: str, conversation_id: str) -> dict | None:
    conn = _connection()
    try:
        row = conn.execute("SELECT id, title, updated_at, codex_session_id, skill_ids_json FROM agent_conversations WHERE id = ? AND project_id = ? AND actor_email = ?", (conversation_id, project_id, actor_email)).fetchone()
        if not row: return None
        messages = conn.execute("SELECT id, role, text, evidence_json, attachments_json, created_at FROM agent_messages WHERE conversation_id = ? ORDER BY created_at, rowid", (conversation_id,)).fetchall()
        return {"id": row["id"], "title": row["title"], "updated_at": row["updated_at"], "codex_session_id": row["codex_session_id"], "skill_ids": json.loads(row["skill_ids_json"] or "[]"), "messages": [{"id": item["id"], "role": item["role"], "text": item["text"], "evidence": json.loads(item["evidence_json"]), "attachments": json.loads(item["attachments_json"] or "[]"), "created_at": item["created_at"]} for item in messages]}
    finally:
        conn.close()


def rename_conversation(*, project_id: str, actor_email: str, conversation_id: str, title: str) -> bool:
    conn = _connection()
    try:
        cursor = conn.execute(
            "UPDATE agent_conversations SET title = ?, updated_at = ? WHERE id = ? AND project_id = ? AND actor_email = ?",
            (title.strip()[:80], _now(), conversation_id, project_id, actor_email),
        )
        conn.commit()
        return cursor.rowcount == 1
    finally:
        conn.close()


def delete_conversation(*, project_id: str, actor_email: str, conversation_id: str) -> bool:
    conn = _connection()
    try:
        existing = conn.execute(
            "SELECT id FROM agent_conversations WHERE id = ? AND project_id = ? AND actor_email = ?",
            (conversation_id, project_id, actor_email),
        ).fetchone()
        if not existing:
            return False
        conn.execute("DELETE FROM agent_messages WHERE conversation_id = ?", (conversation_id,))
        conn.execute("DELETE FROM agent_conversations WHERE id = ?", (conversation_id,))
        conn.commit()
        return True
    finally:
        conn.close()
