from __future__ import annotations

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
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_prompt_suggestions ("
        "id TEXT PRIMARY KEY, actor_email TEXT NOT NULL COLLATE NOCASE, "
        "title TEXT NOT NULL, prompt TEXT NOT NULL, "
        "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS ix_agent_prompt_suggestions_actor_updated "
        "ON agent_prompt_suggestions(actor_email, updated_at DESC)"
    )
    return conn


def _out(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "prompt": row["prompt"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_suggestions(*, actor_email: str) -> list[dict]:
    conn = _connection()
    try:
        rows = conn.execute(
            "SELECT id, title, prompt, created_at, updated_at "
            "FROM agent_prompt_suggestions WHERE actor_email = ? "
            "ORDER BY updated_at DESC, title COLLATE NOCASE",
            (actor_email,),
        ).fetchall()
        return [_out(row) for row in rows]
    finally:
        conn.close()


def create_suggestion(*, actor_email: str, title: str, prompt: str) -> dict:
    now = _now()
    item = {"id": str(uuid4()), "title": title.strip(), "prompt": prompt.strip(), "created_at": now, "updated_at": now}
    conn = _connection()
    try:
        conn.execute(
            "INSERT INTO agent_prompt_suggestions(id, actor_email, title, prompt, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (item["id"], actor_email, item["title"], item["prompt"], now, now),
        )
        conn.commit()
        return item
    finally:
        conn.close()


def update_suggestion(*, actor_email: str, suggestion_id: str, title: str | None, prompt: str | None) -> dict | None:
    conn = _connection()
    try:
        current = conn.execute(
            "SELECT id, title, prompt FROM agent_prompt_suggestions WHERE id = ? AND actor_email = ?",
            (suggestion_id, actor_email),
        ).fetchone()
        if not current:
            return None
        next_title = title.strip() if title is not None else current["title"]
        next_prompt = prompt.strip() if prompt is not None else current["prompt"]
        updated_at = _now()
        conn.execute(
            "UPDATE agent_prompt_suggestions SET title = ?, prompt = ?, updated_at = ? WHERE id = ? AND actor_email = ?",
            (next_title, next_prompt, updated_at, suggestion_id, actor_email),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, title, prompt, created_at, updated_at FROM agent_prompt_suggestions "
            "WHERE id = ? AND actor_email = ?",
            (suggestion_id, actor_email),
        ).fetchone()
        return _out(row) if row else None
    finally:
        conn.close()


def delete_suggestion(*, actor_email: str, suggestion_id: str) -> bool:
    conn = _connection()
    try:
        cursor = conn.execute(
            "DELETE FROM agent_prompt_suggestions WHERE id = ? AND actor_email = ?",
            (suggestion_id, actor_email),
        )
        conn.commit()
        return cursor.rowcount == 1
    finally:
        conn.close()
