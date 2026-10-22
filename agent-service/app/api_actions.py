"""Strict, user-confirmed write-action proposals emitted by Codex."""
from __future__ import annotations

import json
import re
from typing import Any

_BLOCK = re.compile(r"```cloudtool-api-action\s*\n([\s\S]*?)```", re.IGNORECASE)
MAX_ACTIONS_PER_RESPONSE = 20


def _security_group_rule_action(raw: str) -> dict[str, Any] | None:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(value, dict) or value.get("type") != "security_group_rule.create":
        return None
    group_id = str(value.get("security_group_id") or "").strip()
    rule = value.get("rule")
    if not group_id or len(group_id) > 120 or not isinstance(rule, dict):
        return None
    allowed = {"description", "direction", "protocol", "port_range_min", "port_range_max", "remote_ip_prefix"}
    rule = {key: rule[key] for key in allowed if key in rule}
    if rule.get("direction") not in {"ingress", "egress"} or not isinstance(rule.get("protocol"), str) or not isinstance(rule.get("remote_ip_prefix"), str):
        return None
    for key in ("port_range_min", "port_range_max"):
        if key in rule and (not isinstance(rule[key], int) or not 1 <= rule[key] <= 65535):
            return None
    if ("port_range_min" in rule) != ("port_range_max" in rule):
        return None
    if rule.get("port_range_min", 0) > rule.get("port_range_max", 65535):
        return None
    return {"type": "security_group_rule.create", "security_group_id": group_id, "rule": rule, "summary": str(value.get("summary") or "Create one security-group rule")[:500]}


def security_group_rule_batch_action(group_id: object, rules: object, summary: object = None) -> dict[str, Any] | None:
    """Validate a bounded same-group batch for one explicit browser approval."""
    normalized_group = str(group_id or "").strip()
    if not normalized_group or len(normalized_group) > 120 or not isinstance(rules, list) or not 1 <= len(rules) <= MAX_ACTIONS_PER_RESPONSE:
        return None
    validated: list[dict[str, Any]] = []
    for rule in rules:
        candidate = _security_group_rule_action(json.dumps({"type": "security_group_rule.create", "security_group_id": normalized_group, "rule": rule}))
        if not candidate:
            return None
        validated.append(candidate["rule"])
    return {
        "type": "security_group_rule.create",
        "security_group_id": normalized_group,
        "rules": validated,
        "summary": str(summary or f"Create {len(validated)} security-group rule(s)")[:500],
    }


def extract_security_group_rule_actions(text: str) -> list[dict[str, Any]]:
    """Extract bounded, independently validated action blocks in source order."""
    actions: list[dict[str, Any]] = []
    for match in _BLOCK.finditer(text):
        action = _security_group_rule_action(match.group(1))
        if action:
            actions.append(action)
        if len(actions) >= MAX_ACTIONS_PER_RESPONSE:
            break
    return actions


def extract_security_group_rule_action(text: str) -> dict[str, Any] | None:
    """Compatibility helper for the single-action execution endpoint."""
    actions = extract_security_group_rule_actions(text)
    return actions[0] if actions else None


def remove_api_action_block(text: str) -> str:
    return _BLOCK.sub("", text).strip()
