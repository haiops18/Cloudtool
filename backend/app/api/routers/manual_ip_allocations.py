"""Allocate IP resources for draft VMs without creating or changing any VM."""

import asyncio
import ipaddress
import secrets
import time
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from app.api.deps import CloudContext, Csrf, Db, Operator
from app.core.permissions import has_permission
from app.core.time import db_now
from app.gateway import cloud_v1
from app.models import ResourceMarker
from app.services.audit import write_audit

router = APIRouter(prefix="/ip-allocations", tags=["Manual IP allocations"])


class ManualIpItem(BaseModel):
    server_draft_id: str = Field(min_length=1, max_length=100)
    server_name: str = Field(min_length=1, max_length=160)
    subnet_id: str | None = Field(default=None, max_length=100)
    region_id: str | None = Field(default=None, max_length=100)
    zone_id: str | None = Field(default=None, max_length=100)
    create_private: bool = False
    create_elastic: bool = False

    @model_validator(mode="after")
    def requirements(self):
        if not self.create_private and not self.create_elastic:
            raise ValueError("Select at least one IP type")
        if self.create_private and not self.subnet_id:
            raise ValueError("Subnet is required for private IP creation")
        if self.create_elastic and not self.zone_id:
            raise ValueError("VM zone is required for Elastic IP creation")
        return self


class ManualIpBatch(BaseModel):
    request_id: UUID
    items: list[ManualIpItem] = Field(min_length=1, max_length=200)
    max_attempts: int = Field(default=5, ge=1, le=20)

    @model_validator(mode="after")
    def unique_drafts(self):
        if len({item.server_draft_id for item in self.items}) != len(self.items):
            raise ValueError("Each draft must appear only once")
        return self


def random_free_address(network, occupied: set[int]) -> str:
    """Pick a uniform free rank, without enumerating the subnet's host range."""
    if network.version != 4:
        raise ValueError("Manual allocation currently supports IPv4 subnets only")
    first, last = int(network.network_address) + 2, int(network.broadcast_address) - 1
    excluded = sorted(value for value in occupied if first <= value <= last)
    free_count = last - first + 1 - len(excluded)
    if free_count <= 0:
        raise ValueError("No unused private IP remains in this subnet")
    candidate = first + secrets.randbelow(free_count)
    for value in excluded:
        if value > candidate:
            break
        candidate += 1
    return str(ipaddress.ip_address(candidate))


def _resource_id(value):
    return value.get("id") if isinstance(value, dict) else value


def _allocation_error(exc):
    detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
    if isinstance(detail, dict) and detail.get("upstream_detail"):
        return str(detail["upstream_detail"])
    return str(detail)


def _allocated(row, project):
    if not isinstance(row, dict) or not row.get("id") or row.get("server") is not None:
        raise ValueError("Cloud API did not return an available IP resource")
    if row.get("project") and _resource_id(row["project"]) != project:
        raise ValueError("Allocated IP belongs to another project")
    address = str(ipaddress.IPv4Address(row.get("ip_address")))
    return {"status": "completed", "ip_id": row["id"], "ip_address": address}


class BatchState:
    def __init__(self, payload):
        self.payload = payload
        self.expires = time.monotonic() + 1800
        self.lock = asyncio.Lock()
        self.results: dict[tuple[str, str], dict] = {}


# Replays of a timed-out request in this worker reuse already-created resources.
# Never automatically replay an ambiguous Cloud mutation under a new request ID.
_batches: dict[tuple[str, str, UUID], BatchState] = {}


@router.post("/create-manual")
async def create_manual_ips(payload: ManualIpBatch, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    project, token, approval = context
    if user.cloud_api_access != "full" or not has_permission(user, "private_ips"):
        raise HTTPException(403, "IP allocation requires full Cloud access and network permission")
    for key, value in list(_batches.items()):
        if value.expires < time.monotonic() and not value.lock.locked():
            del _batches[key]
    key = (user.id, project, payload.request_id)
    state = _batches.get(key)
    if state is None:
        if len(_batches) >= 512:
            raise HTTPException(503, "Too many allocation batches; retry later")
        state = _batches[key] = BatchState(payload.model_dump(mode="json"))
    elif state.payload != payload.model_dump(mode="json"):
        raise HTTPException(409, "Request ID was already used for a different allocation")

    async with state.lock:
        networks, occupied = {}, {}
        if any(item.create_private and (item.server_draft_id, "private") not in state.results for item in payload.items):
            data, _ = await cloud_v1.list_resource(db, user, token, project, "subnets", 1, 200, approval=approval)
            networks = {item["id"]: item for item in data.get("results", [])}
        zone_regions = {}
        if any(item.create_elastic and (item.server_draft_id, "elastic") not in state.results for item in payload.items):
            data, _ = await cloud_v1.call(db, user, token, "GET", "/legacy/api/organization/zones/", project, params={"page": 1, "page_size": 200}, approval=approval)
            zone_regions = {zone.get("id"): _resource_id(zone.get("region")) for zone in data.get("results", [])}

        async def private_ip(item):
            subnet = networks.get(item.subnet_id)
            if not subnet or not subnet.get("cidr"):
                raise ValueError("Subnet was not found in the current project")
            network = ipaddress.ip_network(subnet["cidr"], strict=False)
            if item.subnet_id not in occupied:
                data, _ = await cloud_v1.list_resource(db, user, token, project, "private-ips", 1, 200,
                    params={"subnet_id": item.subnet_id, "_include_all_private_ips": "true"}, approval=approval)
                occupied[item.subnet_id] = set()
                for row in data.get("results", []):
                    if row.get("ip_address"):
                        occupied[item.subnet_id].add(int(ipaddress.ip_address(row["ip_address"])))
            for attempt in range(payload.max_attempts):
                address = random_free_address(network, occupied[item.subnet_id])
                occupied[item.subnet_id].add(int(ipaddress.ip_address(address)))
                try:
                    row, _ = await cloud_v1.create_resource(db, user, token, project, "private-ips",
                        {"ip_address": address, "description": "", "subnet": item.subnet_id}, approval)
                except HTTPException as exc:
                    # Only a definite conflict is safe to retry on a new address.
                    if exc.status_code == 409 and attempt + 1 < payload.max_attempts:
                        continue
                    raise
                result = _allocated(row, project)
                if result["ip_address"] != address or row.get("description") not in (None, ""):
                    raise ValueError("Cloud API did not return the requested unused private IP")
                return result

        async def elastic_ip(item):
            region = zone_regions.get(item.zone_id)
            if not region:
                raise ValueError("VM zone or its region was not found in the current project")
            # Derive the region from the authoritative zone catalog, rather
            # than trusting a stale region value in the client draft.
            row, _ = await cloud_v1.create_elastic_ip(db, user, token, project, region, approval)
            result = _allocated(row, project)
            if row.get("region") and _resource_id(row["region"]) != region:
                raise ValueError("Elastic IP was allocated in another region")
            return result

        results = []
        for item in payload.items:
            result = {"server_draft_id": item.server_draft_id, "server_name": item.server_name}
            for kind, required, allocator in (("elastic", item.create_elastic, elastic_ip), ("private", item.create_private, private_ip)):
                if not required:
                    continue
                resource_key = (item.server_draft_id, kind)
                if resource_key not in state.results:
                    try:
                        allocation = await allocator(item)
                        state.results[resource_key] = allocation
                        db.add(ResourceMarker(project_id=project, resource_type=f"{kind}_ip", resource_id=allocation["ip_id"], actor_id=user.id, marked_at=db_now(), result="completed"))
                        await db.commit()
                    except (HTTPException, ValueError, TypeError) as exc:
                        allocation = {"status": "failed", "error": _allocation_error(exc)}
                        state.results[resource_key] = allocation
                    if kind == "elastic":
                        allocation = state.results[resource_key]
                        await write_audit(
                            db, user, "elastic_ip.create",
                            "success" if allocation["status"] == "completed" else "failed",
                            project_id=project, target_type="elastic_ip", target_id=allocation.get("ip_id"),
                            metadata={"server_draft_id": item.server_draft_id, "server_name": item.server_name,
                                "zone_id": item.zone_id, "region": zone_regions.get(item.zone_id),
                                "request_id": str(payload.request_id), **allocation},
                        )
                result[kind] = state.results[resource_key]
            results.append(result)
        await write_audit(db, user, "ip.create_manual", "completed", project_id=project,
            metadata={"request_id": str(payload.request_id), "requested": len(payload.items), "results": results})
        return {"items": results}
