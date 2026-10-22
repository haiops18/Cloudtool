"""Per-request, read-only CloudTool MCP server for the local Codex CLI."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any

import httpx

from app.gateway import Caller, CloudToolGateway
from app.security import redact
from app.vm_lookups import VmLookup, VmLookupBatch, lookup, lookup_many

gateway = CloudToolGateway()


def _caller() -> Caller:
    required = {key: os.environ.get(key, "") for key in ("CLOUDTOOL_MCP_EMAIL", "CLOUDTOOL_MCP_PROJECT_ID", "CLOUDTOOL_MCP_TOKEN", "CLOUDTOOL_MCP_COOKIE")}
    if not all(required.values()):
        raise RuntimeError("CloudTool MCP request context is unavailable")
    return Caller(required["CLOUDTOOL_MCP_EMAIL"], "agent", required["CLOUDTOOL_MCP_PROJECT_ID"], required["CLOUDTOOL_MCP_TOKEN"], required["CLOUDTOOL_MCP_COOKIE"], None)


def _items(value: Any) -> list[dict[str, Any]]:
    return gateway._items(value)


def _compact(value: Any, limit: int) -> Any:
    safe = redact(value)
    if isinstance(safe, list):
        return safe[:limit]
    if isinstance(safe, dict):
        result = dict(safe)
        for key in ("items", "results"):
            if isinstance(result.get(key), list):
                result[key] = result[key][:limit]
        return result
    return safe


async def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    caller = _caller()
    async with httpx.AsyncClient(timeout=30) as client:
        return await gateway._get(client, caller, path, params)


async def search_servers(query: str = "", limit: int = 20) -> str:
    """Search servers; with an empty query this also returns the exact total count."""
    data = await _get("/cloud/servers", {"page_size": 200})
    items = _items(data)
    needle = query.strip().lower()
    if needle:
        items = [item for item in items if needle in json.dumps(item, ensure_ascii=False).lower()]
    returned = _compact(items, max(1, min(limit, 50)))
    result: dict[str, Any] = {"items": returned, "matched_count": len(items)}
    # CloudTool's paginated endpoint returns ``total``. Preserve it for an
    # unfiltered count question, without making Codex infer a count from a
    # truncated item list.
    if not needle and isinstance(data, dict) and isinstance(data.get("total"), int):
        result["total"] = data["total"]
    return json.dumps(result, ensure_ascii=False)


async def get_server_details(server_id: str) -> str:
    """Get one server's read-only details. Use an ID returned by search_servers."""
    return json.dumps(_compact(await _get(f"/cloud/servers/{server_id}"), 50), ensure_ascii=False)


async def get_inventory(limit: int = 50) -> str:
    """Get the project server inventory snapshot, read-only and bounded."""
    return json.dumps(_compact(await _get("/cloud/server-inventory"), max(1, min(limit, 100))), ensure_ascii=False)


async def list_subnets(limit: int = 50) -> str:
    """List project subnets, read-only and bounded."""
    return json.dumps(_compact(await _get("/cloud/subnets", {"page_size": max(1, min(limit, 100))}), max(1, min(limit, 100))), ensure_ascii=False)


async def list_security_groups(limit: int = 50) -> str:
    """List project security groups, read-only and bounded."""
    return json.dumps(_compact(await _get("/cloud/security-groups"), max(1, min(limit, 100))), ensure_ascii=False)


async def get_audit_events(limit: int = 50) -> str:
    """Read recent project audit events. Never performs mutations."""
    caller = _caller()
    return json.dumps(_compact(await _get("/logs/audit", {"project_id": caller.project_id, "page_size": max(1, min(limit, 100))}), max(1, min(limit, 100))), ensure_ascii=False)


async def get_cloud_api_history(limit: int = 50) -> str:
    """Read recent Cloud API history for this project. Never performs mutations."""
    caller = _caller()
    return json.dumps(_compact(await _get("/logs/cloud-api", {"project_id": caller.project_id, "page_size": max(1, min(limit, 100))}), max(1, min(limit, 100))), ensure_ascii=False)


_READ_ONLY = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}


async def get_vm_creation_options(**arguments: Any) -> str:
    """Read one live VM configuration catalog in the current project."""
    request = VmLookup.model_validate(arguments)
    async with httpx.AsyncClient(timeout=30) as client:
        result = await lookup(client, gateway, _caller(), request)
    return json.dumps(result, ensure_ascii=False)


async def batch_vm_creation_options(**arguments: Any) -> str:
    """Run up to 16 independent VM catalog reads, at most four concurrently."""
    batch = VmLookupBatch.model_validate(arguments)
    return json.dumps(await lookup_many(gateway, _caller(), batch.requests), ensure_ascii=False)


TOOLS = [
    {"name": "get_vm_creation_options", "description": "Read live VM creation configuration in the current project. Read api-docs/vm-creation-lookups.md. Supports regions, zones, flavors, images, volume_types, vpcs, subnets, security_groups, keypairs, elastic_ips, enis, private_ips, placement_groups, cloud_init_templates; cloud_init_template with template_id returns template variables; deployment_schema returns the exact create contract; deployment_status with deployment_id returns progress and actual server IDs. Paginate with next_page; exact IDs, never guessed values. Ask the user to resolve ambiguous selections.", "inputSchema": VmLookup.model_json_schema(), "annotations": _READ_ONLY},
    {"name": "batch_vm_creation_options", "description": "Read up to 16 VM configuration catalogs in parallel (4 upstream requests at once). Use for independent lookups; inspect per-request results/errors, then call again for dependent zone/region/subnet selections. Multiple calls in one chat turn are supported; do not ask the user to trigger each lookup.", "inputSchema": VmLookupBatch.model_json_schema(), "annotations": _READ_ONLY},
    {"name": "search_servers", "description": "Find project servers by name, ID, or IP. Empty query returns the exact total server count. Use first for server questions.", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 50}}}, "annotations": _READ_ONLY},
    {"name": "get_server_details", "description": "Read one server by ID returned from search_servers.", "inputSchema": {"type": "object", "properties": {"server_id": {"type": "string"}}, "required": ["server_id"]}, "annotations": _READ_ONLY},
    {"name": "get_inventory", "description": "Read the bounded project inventory snapshot.", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 100}}}, "annotations": _READ_ONLY},
    {"name": "list_subnets", "description": "Read bounded project subnet records.", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 100}}}, "annotations": _READ_ONLY},
    {"name": "list_security_groups", "description": "Read bounded project security group records.", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 100}}}, "annotations": _READ_ONLY},
    {"name": "get_audit_events", "description": "Read recent project audit events.", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 100}}}, "annotations": _READ_ONLY},
    {"name": "get_cloud_api_history", "description": "Read recent project Cloud API history.", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 100}}}, "annotations": _READ_ONLY},
]


async def _call_tool(name: str, arguments: dict[str, Any]) -> str:
    handlers = {
        "get_vm_creation_options": get_vm_creation_options,
        "batch_vm_creation_options": batch_vm_creation_options,
        "search_servers": search_servers,
        "get_server_details": get_server_details,
        "get_inventory": get_inventory,
        "list_subnets": list_subnets,
        "list_security_groups": list_security_groups,
        "get_audit_events": get_audit_events,
        "get_cloud_api_history": get_cloud_api_history,
    }
    handler = handlers.get(name)
    if handler is None:
        raise ValueError(f"Unknown read-only tool: {name}")
    return await handler(**arguments)


def _send(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _debug(value: str) -> None:
    path = os.environ.get("CLOUDTOOL_MCP_DEBUG_LOG")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(value + "\n")


def main() -> None:
    """Minimal stdio MCP protocol implementation for Codex CLI compatibility."""
    for raw in sys.stdin:
        try:
            _debug(f"IN {raw!r}")
            request = json.loads(raw)
            request_id = request.get("id")
            method = request.get("method")
            if method == "initialize":
                _send({"jsonrpc": "2.0", "id": request_id, "result": {
                    "protocolVersion": request.get("params", {}).get("protocolVersion", "2024-11-05"),
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "cloudtool-readonly", "version": "1.0.0"},
                }})
            elif method == "tools/list":
                _send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}})
            elif method == "tools/call":
                params = request.get("params") or {}
                try:
                    text = asyncio.run(_call_tool(str(params.get("name") or ""), dict(params.get("arguments") or {})))
                    result = {"content": [{"type": "text", "text": text}]}
                except Exception as exc:
                    result = {"content": [{"type": "text", "text": f"CloudTool read-only lookup failed: {exc}"}], "isError": True}
                _send({"jsonrpc": "2.0", "id": request_id, "result": result})
            elif request_id is not None:
                _send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"Unsupported method: {method}"}})
        except Exception as exc:
            _debug(f"ERROR {exc!r}")
            if isinstance(locals().get("request_id"), (str, int)):
                _send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": str(exc)}})


if __name__ == "__main__":
    main()
