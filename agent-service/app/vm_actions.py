"""Parse explicit, user-approval-gated VM console action proposals from Codex."""
from __future__ import annotations

import json
import re
from typing import Any

_BLOCK = re.compile(r"```cloudtool-vm-action\s*\n([\s\S]*?)```", re.IGNORECASE)


def extract_vm_action(text: str) -> dict[str, str] | None:
    """Accept only one small, well-formed proposed action; never execute it."""
    match = _BLOCK.search(text)
    if not match:
        return None
    try:
        value: Any = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    if not isinstance(value, dict):
        return None
    server = str(value.get("server") or "").strip()
    command = str(value.get("command") or "").strip()
    summary = str(value.get("summary") or "VM diagnostic command").strip()
    if not server or len(server) > 180 or not command or len(command) > 4000 or len(summary) > 500:
        return None
    return {"server": server, "command": command, "summary": summary}


def remove_vm_action_block(text: str) -> str:
    """Keep the transport directive out of the user-visible chat transcript."""
    return _BLOCK.sub("", text).strip()
