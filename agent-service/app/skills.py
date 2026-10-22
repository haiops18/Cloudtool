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
    conn.execute("CREATE TABLE IF NOT EXISTS agent_skills (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL COLLATE NOCASE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_agent_skills_actor_updated ON agent_skills(actor_email, updated_at DESC)")
    return conn


def _out(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in ("id", "title", "description", "instructions", "created_at", "updated_at")}


def list_skills(*, actor_email: str) -> list[dict]:
    conn = _connection()
    try:
        return [_out(row) for row in conn.execute("SELECT id, title, description, instructions, created_at, updated_at FROM agent_skills WHERE actor_email = ? ORDER BY updated_at DESC, title COLLATE NOCASE", (actor_email,)).fetchall()]
    finally:
        conn.close()


def create_skill(*, actor_email: str, title: str, description: str, instructions: str) -> dict:
    now = _now(); item = {"id": str(uuid4()), "title": title.strip(), "description": description.strip(), "instructions": instructions.strip(), "created_at": now, "updated_at": now}
    conn = _connection()
    try:
        conn.execute("INSERT INTO agent_skills(id, actor_email, title, description, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", (item["id"], actor_email, item["title"], item["description"], item["instructions"], now, now)); conn.commit(); return item
    finally:
        conn.close()


def update_skill(*, actor_email: str, skill_id: str, title: str | None, description: str | None, instructions: str | None) -> dict | None:
    conn = _connection()
    try:
        row = conn.execute("SELECT id, title, description, instructions FROM agent_skills WHERE id = ? AND actor_email = ?", (skill_id, actor_email)).fetchone()
        if not row: return None
        values = (title.strip() if title is not None else row["title"], description.strip() if description is not None else row["description"], instructions.strip() if instructions is not None else row["instructions"], _now(), skill_id, actor_email)
        conn.execute("UPDATE agent_skills SET title = ?, description = ?, instructions = ?, updated_at = ? WHERE id = ? AND actor_email = ?", values); conn.commit()
        result = conn.execute("SELECT id, title, description, instructions, created_at, updated_at FROM agent_skills WHERE id = ? AND actor_email = ?", (skill_id, actor_email)).fetchone()
        return _out(result) if result else None
    finally:
        conn.close()


def delete_skill(*, actor_email: str, skill_id: str) -> bool:
    conn = _connection()
    try:
        result = conn.execute("DELETE FROM agent_skills WHERE id = ? AND actor_email = ?", (skill_id, actor_email)); conn.commit(); return result.rowcount == 1
    finally:
        conn.close()


def resolve_skills(*, actor_email: str, skill_ids: list[str]) -> list[dict]:
    unique = list(dict.fromkeys(skill_ids))
    if not unique: return []
    if len(unique) > 12: raise ValueError("Select at most 12 skills per conversation")
    placeholders = ", ".join("?" for _ in unique)
    conn = _connection()
    try:
        rows = conn.execute(f"SELECT id, title, description, instructions, created_at, updated_at FROM agent_skills WHERE actor_email = ? AND id IN ({placeholders})", (actor_email, *unique)).fetchall()
        found = {row["id"]: _out(row) for row in rows}
        if len(found) != len(unique): raise ValueError("One or more selected skills are unavailable")
        return [found[skill_id] for skill_id in unique]
    finally:
        conn.close()
