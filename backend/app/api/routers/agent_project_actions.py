"""Service-only IP writes. Never accepts arbitrary methods, paths or projects."""
import ipaddress
import asyncio
import secrets
import time
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import CloudContext, Db, Operator
from app.api.routers.manual_ip_allocations import ManualIpBatch, create_manual_ips, _allocated, random_free_address, BatchState, _allocation_error
from app.core.config import get_settings
from app.core.permissions import has_permission
from app.core.time import db_now
from app.gateway import cloud_v1
from app.models import ResourceMarker
from app.services.audit import write_audit

router = APIRouter(prefix="/cloud/ip-allocations/internal/agent", tags=["Agent project actions"])


class IpCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    subnet_id: str | None = Field(default=None, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._-]+$")
    zone_id: str | None = Field(default=None, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._-]+$")
    ip_address: ipaddress.IPv4Address | None = None


class IpAttach(BaseModel):
    model_config = ConfigDict(extra="forbid")
    server_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._-]+$")
    ip_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._-]+$")


def authorize(request, user, *, attach=False):
    configured = get_settings().AGENT_SERVICE_BACKEND_KEY or ""
    supplied = request.headers.get("X-Agent-Service-Key", "")
    if not configured or not supplied or not secrets.compare_digest(configured, supplied):
        raise HTTPException(401, "Invalid Agent Service key")
    if user.cloud_api_access != "full" or not has_permission(user, "private_ips") or (attach and not has_permission(user, "servers")):
        raise HTTPException(403, "Full Cloud access and resource permissions are required")


def relation(value):
    return str(value.get("id") or "") if isinstance(value, dict) else str(value or "")


# Keep only small request/result records, never subnet/IP catalogs. A replay in
# this worker shares the same lock/result for automatic AND exact private IPs.
_private_allocations = {}


async def allocate_private_ip(payload, context, user, db):
    project, token, approval = context
    for key, state in list(_private_allocations.items()):
        if state.expires < time.monotonic() and not state.lock.locked():
            _private_allocations.pop(key, None)
    key = (user.id, project, payload.request_id)
    serialized = payload.model_dump(mode="json")
    state = _private_allocations.get(key)
    if state is None:
        if len(_private_allocations) >= 512:
            raise HTTPException(503, "Too many IP allocation requests; retry later")
        state = _private_allocations[key] = BatchState(serialized)
    elif state.payload != serialized:
        raise HTTPException(409, "Request ID was already used for another private IP allocation")
    async with state.lock:
        cached = state.results.get(("agent", "private"))
        if cached:
            if cached.get("status") == "completed":
                return dict(cached)
            raise HTTPException(cached["http_status"], cached["error"])
        try:
            result = await _allocate_private_ip(payload, context, user, db)
            state.results[("agent", "private")] = result
            return dict(result)
        except (Exception, asyncio.CancelledError) as exc:
            # Even cancellation/a lost response must not trigger another POST
            # under the same request ID. Successful resources remain visible in
            # inventory if a later DB/audit operation failed.
            state.results[("agent", "private")] = {
                "status": "failed", "http_status": exc.status_code if isinstance(exc, HTTPException) else 502,
                "error": _allocation_error(exc)[:4000] if isinstance(exc, HTTPException) else
                "Allocation outcome could not be confirmed; inspect inventory before retrying",
            }
            raise


async def _allocate_private_ip(payload, context, user, db):
    project, token, approval = context
    subnet, _ = await cloud_v1.call(db, user, token, "GET", f"/legacy/api/infra/subnets/{payload.subnet_id}/", project, approval=approval)
    if relation(subnet.get("project")) != project:
        raise HTTPException(403, "Subnet does not belong to current project")
    try:
        network = ipaddress.ip_network(subnet.get("cidr", ""), strict=False)
        if network.version != 4:
            raise ValueError("IPv4 subnet required")
    except ValueError:
        raise HTTPException(422, "Select a subnet with a valid IPv4 CIDR") from None
    occupied = set()
    if not payload.ip_address:
        # Consume pages into integer addresses, rather than retaining a merged
        # catalog of every IP record while the allocation/audit completes.
        size = min(200, get_settings().CLOUD_API_LIST_PAGE_SIZE)
        page, scanned, previous = 1, 0, None
        while True:
            data, _ = await cloud_v1.call(db, user, token, "GET", "/legacy/api/infra/private-ips/", project,
                params={"subnet_id": payload.subnet_id, "_include_all_private_ips": "true", "page": page, "page_size": size}, approval=approval)
            rows = data.get("results", [])
            fingerprint = tuple(str(row.get("id") or row.get("ip_address")) for row in rows)
            if rows and fingerprint == previous:
                raise HTTPException(502, "Private IP inventory repeated a page; allocation stopped")
            previous = fingerprint
            for row in rows:
                if row.get("ip_address"):
                    occupied.add(int(ipaddress.ip_address(row["ip_address"])))
            scanned += len(rows)
            try:
                total = int(data["count"]) if data.get("count") is not None else None
            except (ValueError, TypeError):
                total = None
            more = bool(data.get("next")) or (total is not None and scanned < total)
            if not more and (total is not None or len(rows) < size):
                break
            if not rows or page >= 10000:
                raise HTTPException(502, "Could not read the complete subnet IP inventory; allocation stopped")
            page += 1
        del data, rows
    for attempt in range(1 if payload.ip_address else 3):
        try:
            address = str(payload.ip_address) if payload.ip_address else random_free_address(network, occupied)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        selected = ipaddress.IPv4Address(address)
        if selected not in network or int(selected) <= int(network.network_address) + 1 or selected == network.broadcast_address:
            raise HTTPException(422, "Address is outside the subnet or reserved")
        occupied.add(int(selected))
        try:
            row, _ = await cloud_v1.create_resource(db, user, token, project, "private-ips",
                {"ip_address": address, "description": "", "subnet": payload.subnet_id}, approval)
        except HTTPException as exc:
            if not payload.ip_address and exc.status_code == 409 and attempt < 2:
                continue  # Only a definite conflict permits selecting another address.
            raise
        try:
            result = _allocated(row, project)
        except (ValueError, TypeError):
            raise HTTPException(502, "Cloud API did not return the allocated IP; inspect inventory before retrying") from None
        if result["ip_address"] != address or row.get("description") not in (None, ""):
            raise HTTPException(502, "Cloud API returned a different/private IP in use; inspect inventory before retrying")
        result["subnet_id"] = payload.subnet_id
        db.add(ResourceMarker(project_id=project, resource_type="private_ip", resource_id=result["ip_id"], actor_id=user.id, marked_at=db_now(), result="completed"))
        await db.commit()
        await write_audit(db, user, "agent.private_ip.create", "success", project_id=project, target_type="private_ip", target_id=result["ip_id"], metadata={"request_id": str(payload.request_id)})
        return result


@router.post("/{kind}/create", include_in_schema=False)
async def create_ip(kind: str, payload: IpCreate, request: Request, context: CloudContext, user: Operator, db: Db):
    authorize(request, user)
    if kind not in {"private-ip", "elastic-ip"}:
        raise HTTPException(404, "Unsupported IP action")
    private = kind == "private-ip"
    if (private and (not payload.subnet_id or payload.zone_id)) or (not private and (not payload.zone_id or payload.subnet_id or payload.ip_address)):
        raise HTTPException(422, "Private IP requires subnet_id; Elastic IP requires zone_id")
    if private:
        return await allocate_private_ip(payload, context, user, db)
    batch = ManualIpBatch.model_validate({"request_id": payload.request_id, "max_attempts": 1, "items": [{
        "server_draft_id": "agent", "server_name": "Agent IP allocation", "subnet_id": payload.subnet_id,
        "zone_id": payload.zone_id, "create_private": private, "create_elastic": not private,
    }]})
    result = await create_manual_ips(batch, context, user, None, db)
    allocation = result["items"][0]["private" if private else "elastic"]
    if allocation.get("status") != "completed":
        raise HTTPException(502, allocation.get("error") or "IP allocation failed")
    return {**allocation, "zone_id": payload.zone_id}


@router.post("/{kind}/attach", include_in_schema=False)
async def attach_ip(kind: str, payload: IpAttach, request: Request, context: CloudContext, user: Operator, db: Db):
    authorize(request, user, attach=True)
    if kind not in {"private-ip", "elastic-ip"}:
        raise HTTPException(404, "Unsupported IP action")
    project, token, approval = context
    server, _ = await cloud_v1.call(db, user, token, "GET", f"/legacy/api/infra/servers/{payload.server_id}/", project, approval=approval)
    resource = "private-ips" if kind == "private-ip" else "elastic-ips"
    ip, _ = await cloud_v1.call(db, user, token, "GET", f"/legacy/api/infra/{resource}/{payload.ip_id}/", project, approval=approval)
    if relation(server.get("project")) != project or relation(ip.get("project")) != project:
        raise HTTPException(403, "VM and IP must belong to the current project")
    if ip.get("server") is not None or (kind == "private-ip" and ip.get("description") not in (None, "")):
        raise HTTPException(409, "IP is not available for attachment")
    # Check both region IDs and legacy region names against the actual VM zone.
    zones, _ = await cloud_v1.call(db, user, token, "GET", "/legacy/api/organization/zones/", project, params={"page": 1, "page_size": 200}, approval=approval)
    zone = next((z for z in zones.get("results", []) if relation(z.get("id")) == relation(server.get("zone"))), None)
    region = (zone or {}).get("region")
    region_values = {relation(region)}
    if isinstance(region, dict):
        region_values.update(str(region.get(k) or "") for k in ("name", "region_name", "display_name"))
    if not zone or not relation(ip.get("region")) or relation(ip.get("region")) not in region_values - {""}:
        raise HTTPException(409, "VM zone and IP region do not match")
    suffix, key = ("attach-privateip", "privateip") if kind == "private-ip" else ("attach-eip", "eip")
    result, code = await cloud_v1.call(db, user, token, "POST", f"/legacy/api/infra/servers/{payload.server_id}/{suffix}/", project, body={key: payload.ip_id}, approval=approval)
    await write_audit(db, user, f"agent.{kind}.attach", "accepted" if code == 202 else "success", project_id=project, target_type="server", target_id=payload.server_id, metadata={"ip_id": payload.ip_id})
    return {"status": "accepted" if code == 202 else "completed", "server_id": payload.server_id, "ip_id": payload.ip_id, "result": result}
