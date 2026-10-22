import asyncio
import csv
import io
import ipaddress
import json
import re
import secrets
import time
from typing import Any
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import websockets
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from sqlalchemy import String, and_, case, cast, func, or_, select

from app.api.deps import Admin, BootstrapContext, CloudContext, Csrf, Db, Operator, UserDep
from app.api.routers import cli_commands, cloud_init_templates, manual_ip_allocations, network_management, security_groups, vpc_peerings
from app.api.routers.profiles import decrypt_profile
from app.core.config import get_settings
from app.core.time import db_iso, db_now
from app.gateway import cloud_v1
from app.gateway.dolphin import ingest_resources
from app.db.session import SessionFactory
from app.models import PasswordProfile, ResourceMarker
from app.models.entities import AuditLog, AllServerInventorySnapshot, ServerInventorySnapshot
from app.schemas.common import (
    AttachBatch,
    AttachElasticIpBatch,
    DetachElasticIpBatch,
    DetachPrivateIpBatch,
    DolphinInventorySync,
    IpRangeIn,
    OrderedPrivateIpCreate,
    PasswordBatch,
    PrivateIpDeleteBatch,
    RenameBatch,
    ResizeBatch,
    ServerDeleteBatch,
    ServerPowerBatch,
    ServerSecurityGroupsUpdate,
    VolumeAttachmentAttach,
    VolumeAttachmentCreate,
    VolumeAttachmentDetach,
    VolumeAttachmentStatus,
)
from app.services.audit import write_audit

router = APIRouter(prefix="/cloud", tags=["cloud"])
router.include_router(cli_commands.router)
router.include_router(cloud_init_templates.router)
router.include_router(network_management.router)
router.include_router(security_groups.router)
router.include_router(vpc_peerings.router)
router.include_router(manual_ip_allocations.router)
settings = get_settings()
CONSOLE_TICKET_TTL_SECONDS = 60
_console_tickets: dict[str, tuple[str, float]] = {}
INVENTORY_REFERENCE_CACHE_TTL_SECONDS = 120
_inventory_reference_cache: dict[str, tuple[float, dict[str, dict[str, str]]]] = {}


def _issue_console_ticket(url: str) -> str:
    now = time.monotonic()
    expired = [key for key, (_, expires) in _console_tickets.items() if expires <= now]
    for key in expired:
        _console_tickets.pop(key, None)
    ticket = secrets.token_urlsafe(32)
    _console_tickets[ticket] = (url, now + CONSOLE_TICKET_TTL_SECONDS)
    return ticket


async def _relay_browser_to_vnc(browser: WebSocket, upstream) -> None:
    while True:
        message = await browser.receive()
        if message["type"] == "websocket.disconnect":
            return
        if message.get("bytes") is not None:
            await upstream.send(message["bytes"])
        elif message.get("text") is not None:
            await upstream.send(message["text"])


async def _relay_vnc_to_browser(browser: WebSocket, upstream) -> None:
    async for message in upstream:
        if isinstance(message, bytes):
            await browser.send_bytes(message)
        else:
            await browser.send_text(message)


def _console_websocket_url(console_url: str) -> str:
    parsed = urlsplit(console_url)
    path = parse_qs(parsed.query).get("path", [""])[0]
    if not path:
        raise HTTPException(502, "Cloud API returned an unsupported console URL")
    normalized = path if path.startswith("/") else f"/{path}"
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return f"{scheme}://{parsed.netloc}{normalized}"


def page_payload(payload, page, size):
    return {
        "items": payload.get("results", []),
        "total": payload.get("count", 0),
        "page": page,
        "page_size": size,
    }


def _upstream_error_detail(detail: Any) -> str:
    """Keep tables concise while preserving the full gateway response separately."""
    if isinstance(detail, dict):
        value = detail.get("upstream_detail") or detail.get("message") or detail
        return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return str(detail)


@router.get("/organizations")
async def organizations(
    context: BootstrapContext, user: UserDep, db: Db, page: int = 1, page_size: int = 20
):
    token, approval = context
    data, _ = await cloud_v1.organizations(
        db, user, token, page, min(page_size, settings.PAGE_SIZE_MAX), approval
    )
    return page_payload(data, page, page_size)


@router.get("/projects")
async def projects(
    context: BootstrapContext,
    user: UserDep,
    db: Db,
    organization_id: str | None = None,
    q: str | None = None,
    page: int = 1,
    page_size: int = 20,
    picker: bool = False,
):
    token, approval = context
    requested_size = min(page_size, settings.PAGE_SIZE_MAX)
    if picker:
        # The header project picker has server-side search, so its initial
        # request deliberately stays small instead of collecting every project.
        params = {
            "page": page,
            "page_size": requested_size,
            **({"organization": organization_id} if organization_id else {"direct_access": "true"}),
        }
        if q and q.strip():
            params["q"] = q.strip()
        data, _ = await cloud_v1.call(
            db, user, token, "GET", "/legacy/api/tenant/projects/", None,
            params=params, approval=approval,
        )
    else:
        data, _ = await cloud_v1.projects(
            db,
            user,
            token,
            page,
            requested_size,
            organization_id,
            q.strip() if q else None,
            approval,
        )
    return page_payload(data, page, page_size)


@router.get("/current-user")
async def current_cloud_user(context: CloudContext, user: UserDep, db: Db):
    project, token, approval = context
    data, _ = await cloud_v1.current_user(
        db, user, token, project, approval
    )
    return data


@router.get("/quotas")
async def project_quotas(context: CloudContext, user: UserDep, db: Db):
    """Return all quota rows for the active project through the common gateway."""
    project, token, approval = context
    page = 1
    page_size = min(100, settings.PAGE_SIZE_MAX)
    items: list[dict[str, Any]] = []
    total = 0

    # The cloud API paginates quota rows.  Fetch every page so the UI does not
    # silently miss a disk quota that happens to be on a later page.
    while True:
        data, _ = await cloud_v1.call(
            db,
            user,
            token,
            "GET",
            f"/legacy/api/tenant/projects/{project}/quotas/",
            project,
            params={"page": page, "page_size": page_size},
            approval=approval,
        )
        rows = data.get("results", [])
        if not isinstance(rows, list):
            rows = []
        items.extend(row for row in rows if isinstance(row, dict))
        total = int(data.get("count") or len(items))
        if not data.get("next") or not rows:
            break
        page += 1

    await write_audit(
        db,
        user,
        "cloud.quota.review",
        "success",
        project_id=project,
        target_type="project",
        target_id=project,
        metadata={"quota_rows": len(items)},
    )
    return {"items": items, "total": total}


async def get_zones(db, user, token, project, approval=None):
    data, _ = await cloud_v1.call(
        db,
        user,
        token,
        "GET",
        "/legacy/api/organization/zones/",
        project,
        params={"page": 1, "page_size": 200},
        approval=approval,
    )
    return data.get("results", [])


def _reference_label(item: dict[str, Any]) -> str:
    """Use the same human-readable fields exposed by the server-create UI."""
    return str(
        item.get("display_name")
        or item.get("name")
        or item.get("public_image_name")
        or item.get("flavor_name")
        or item.get("ip_address")
        or item.get("id")
        or ""
    )


async def _inventory_reference_maps(db, user, token, project, approval):
    cached = _inventory_reference_cache.get(project)
    if cached and time.monotonic() - cached[0] < INVENTORY_REFERENCE_CACHE_TTL_SECONDS:
        return {key: dict(value) for key, value in cached[1].items()}

    resources = {
        "zone": ("zones", None),
        "subnet": ("subnets", None),
        "key_pair": ("keypairs", None),
        "image": ("images", {"type": "server"}),
        "security_groups": ("security-groups", None),
        "elastic_ip": ("elastic-ips", None),
    }
    maps: dict[str, dict[str, str]] = {}
    for key, (resource, params) in resources.items():
        try:
            if resource == "zones":
                rows = await get_zones(db, user, token, project, approval)
            else:
                payload, _ = await cloud_v1.list_resource(
                    db, user, token, project, resource, 1, 200,
                    params=params, approval=approval,
                )
                rows = payload.get("results", [])
            maps[key] = {
                str(item.get("id")): _reference_label(item)
                for item in rows
                if item.get("id")
            }
        except HTTPException:
            # A missing optional lookup must not make inventory collection fail.
            maps[key] = {}
    _inventory_reference_cache[project] = (time.monotonic(), maps)
    return {key: dict(value) for key, value in maps.items()}


async def _inventory_placement_groups(db, user, token, project, region_id, approval):
    if not region_id:
        return {}
    try:
        payload, _ = await cloud_v1.list_resource(
            db, user, token, project, "placementgroups", 1, 200,
            params={"region": region_id}, approval=approval,
        )
        return {
            str(item.get("id")): _reference_label(item)
            for item in payload.get("results", [])
            if item.get("id")
        }
    except HTTPException:
        return {}


def _snapshot_server_detail(detail: dict[str, Any], references: dict[str, dict[str, str]]):
    """Keep the full useful response while redacting potentially large user-data."""
    snapshot = dict(detail)
    user_data = snapshot.get("user_data", snapshot.get("userData"))
    if isinstance(user_data, str):
        snapshot["user_data"] = user_data[:100]
        if "userData" in snapshot:
            snapshot.pop("userData", None)

    specs = snapshot.get("specs")
    if isinstance(specs, dict):
        snapshot["flavor_name"] = (
            specs.get("flavor_name") or specs.get("name") or snapshot.get("flavor_name")
        )
    boot = snapshot.get("boot")
    if isinstance(boot, dict):
        image = boot.get("public_image_name") or boot.get("image") or boot.get("id")
        if image:
            snapshot["image_name"] = references.get("image", {}).get(
                str(image), str(image)
            )

    raw_volumes = snapshot.get("volumes")
    if isinstance(raw_volumes, list):
        normalized_volumes = []
        for volume in raw_volumes:
            if not isinstance(volume, dict):
                continue
            source = volume.get("volume")
            if not isinstance(source, dict):
                source = volume
            volume_type = source.get("volume_type")
            type_data = volume_type if isinstance(volume_type, dict) else {}
            normalized_volumes.append(
                {
                    "type": _reference_label(type_data)
                    if type_data
                    else (
                        volume_type
                        or source.get("disk_type")
                        or source.get("type")
                        or ""
                    ),
                    "size": source.get("size"),
                    "mount_as": volume.get("mount_as"),
                    "mount_point": (
                        volume.get("mount_point")
                        or volume.get("mount_path")
                        or source.get("mount_point")
                        or source.get("mount_path")
                    ),
                    "iops": source.get("iops") or source.get("max_iops") or type_data.get("iops"),
                    "throughput": source.get("throughput") or source.get("speed") or type_data.get("throughput"),
                }
            )
        snapshot["volume_details"] = normalized_volumes

    resolved: dict[str, Any] = {}
    field_maps = {
        "zone": "zone",
        "subnet": "subnet",
        "key_pair": "key_pair",
        "keypair": "key_pair",
        "image": "image",
        "elastic_ip": "elastic_ip",
        "security_groups": "security_groups",
        "placement_group": "placement_group",
        "placement_groups": "placement_group",
    }
    for field, map_name in field_maps.items():
        value = detail.get(field)
        labels = references.get(map_name, {})
        if isinstance(value, str):
            resolved[field] = labels.get(value, value)
        elif isinstance(value, list):
            resolved[field] = [
                labels.get(str(item.get("id")), _reference_label(item))
                if isinstance(item, dict)
                else labels.get(str(item), str(item))
                for item in value
            ]
        elif isinstance(value, dict):
            identifier = str(value.get("id") or value.get("uuid") or "")
            resolved[field] = labels.get(identifier, _reference_label(value) or identifier)
    snapshot["mapped_references"] = resolved
    private_ips = snapshot.get("private_ip", snapshot.get("private_ips", []))
    if isinstance(private_ips, list):
        subnet_labels = references.get("subnet", {})
        snapshot["private_subnets"] = []
        for private_ip in private_ips:
            if not isinstance(private_ip, dict):
                snapshot["private_subnets"].append("")
                continue
            subnet = private_ip.get("subnet")
            if isinstance(subnet, dict):
                subnet_id = subnet.get("id")
                fallback = _reference_label(subnet)
            else:
                subnet_id = subnet
                fallback = ""
            snapshot["private_subnets"].append(
                subnet_labels.get(str(subnet_id), fallback or str(subnet_id or ""))
            )
    return snapshot


# Fields with a stable scalar meaning are persisted independently.  Everything
# nested stays JSON, while unknown future Cloud API fields are retained in
# `extra` rather than being silently discarded.
_INVENTORY_SCALAR_FIELDS = {
    "power_state", "status", "zone", "region", "server_type", "bandwidth",
    "flavor_name", "image_name", "enable_ipv4", "enable_elastic_ip", "user_data",
}
_INVENTORY_JSON_FIELDS = {
    "specs", "boot", "key_pair", "placement_group", "private_ip", "elastic_ip",
    "volumes", "security_groups", "metadata", "volume_details",
    "mapped_references", "private_subnets",
}


def _inventory_values(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Split a normalized Cloud server response into inventory table columns."""
    values = {
        field: snapshot.get(field)
        for field in _INVENTORY_SCALAR_FIELDS | _INVENTORY_JSON_FIELDS
    }
    values["private_ip"] = snapshot.get("private_ip", snapshot.get("private_ips"))
    values["elastic_ip"] = snapshot.get("elastic_ip", snapshot.get("elastic_ips"))
    values["metadata_json"] = values.pop("metadata")
    values["cloud_created_at"] = snapshot.get("created_at")
    values["cloud_updated_at"] = snapshot.get("updated_at")
    values["inventory_status"] = str(snapshot.get("inventory_status") or "active")
    deleted_at = snapshot.get("deleted_at")
    values["deleted_at"] = (
        datetime.fromisoformat(deleted_at.replace("Z", "+00:00"))
        if isinstance(deleted_at, str) and deleted_at
        else None
    )
    handled = {
        "id", "name", "project", "created_at", "updated_at", "inventory_status",
        "deleted_at", *_INVENTORY_SCALAR_FIELDS, *_INVENTORY_JSON_FIELDS,
    }
    values["extra"] = {key: value for key, value in snapshot.items() if key not in handled}
    return values


def _ip_strings(value: Any) -> list[str]:
    """Extract only IP text from Cloud API IP shapes, retaining source order."""
    result: list[str] = []
    for item in value if isinstance(value, list) else [value]:
        if isinstance(item, dict):
            item = item.get("ip_address") or item.get("address") or item.get("ip")
        if isinstance(item, str) and item.strip():
            result.append(item.strip())
    return list(dict.fromkeys(result))


def _elastic_vip_ips(snapshot: dict[str, Any], elastic_ips: dict[str, dict[str, Any]]) -> list[str]:
    addresses = []
    attached = snapshot.get("elastic_ip", snapshot.get("elastic_ips", []))
    for value in attached if isinstance(attached, list) else [attached]:
        item = value if isinstance(value, dict) else {"id": value}
        source = elastic_ips.get(str(item.get("id") or ""), {})
        vips = item.get("allowed_vips", source.get("allowed_vips", [])) or []
        for vip in vips if isinstance(vips, list) else [vips]:
            vip_id = str(vip.get("id") or "") if isinstance(vip, dict) else str(vip)
            resolved = elastic_ips.get(vip_id, vip)
            for address in _ip_strings(resolved):
                try:
                    addresses.append(str(ipaddress.ip_address(address)))
                except ValueError:
                    continue
    return list(dict.fromkeys(addresses))


def _all_inventory_values(snapshot: dict[str, Any], elastic_ips: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """Persist the compact cross-project schema without duplicating payload JSON."""
    fields = {
        "power_state", "status", "zone", "region", "server_type", "bandwidth",
        "flavor_name", "image_name", "enable_ipv4", "enable_elastic_ip",
    }
    private_source = snapshot.get("private_ip", snapshot.get("private_ips", []))
    vip_values: list[str] = []
    for item in private_source if isinstance(private_source, list) else [private_source]:
        if isinstance(item, dict):
            vip_values.extend(_ip_strings(item.get("vips")))
    deleted_at = snapshot.get("deleted_at")
    return {
        **{field: snapshot.get(field) for field in fields},
        "private_ip": _ip_strings(private_source),
        "vip_ip": list(dict.fromkeys(vip_values)),
        "elastic_ip": _ip_strings(snapshot.get("elastic_ip", snapshot.get("elastic_ips", []))),
        "elastic_vip_ip": _elastic_vip_ips(snapshot, elastic_ips or {}),
        "cloud_created_at": snapshot.get("created_at"),
        "cloud_updated_at": snapshot.get("updated_at"),
        "inventory_status": str(snapshot.get("inventory_status") or "active"),
        "deleted_at": datetime.fromisoformat(deleted_at.replace("Z", "+00:00"))
        if isinstance(deleted_at, str) and deleted_at else None,
    }


def _inventory_snapshot(row: ServerInventorySnapshot) -> dict[str, Any]:
    """Reconstruct the legacy response shape without storing a JSON snapshot."""
    snapshot = dict(row.extra or {})
    snapshot.update(
        {
            "id": row.server_id,
            "name": row.server_name,
            "power_state": row.power_state,
            "status": row.status,
            "zone": row.zone,
            "region": row.region,
            "server_type": row.server_type,
            "bandwidth": row.bandwidth,
            "flavor_name": row.flavor_name,
            "image_name": row.image_name,
            "enable_ipv4": row.enable_ipv4,
            "enable_elastic_ip": row.enable_elastic_ip,
            "user_data": row.user_data,
            "created_at": row.cloud_created_at,
            "updated_at": row.cloud_updated_at,
            "specs": row.specs,
            "boot": row.boot,
            "key_pair": row.key_pair,
            "placement_group": row.placement_group,
            "private_ip": row.private_ip or [],
            "elastic_ip": row.elastic_ip or [],
            "volumes": row.volumes or [],
            "security_groups": row.security_groups or [],
            "metadata": row.metadata_json,
            "volume_details": row.volume_details or [],
            "mapped_references": row.mapped_references or {},
            "private_subnets": row.private_subnets or [],
            "inventory_status": row.inventory_status,
        }
    )
    if row.deleted_at:
        snapshot["deleted_at"] = row.deleted_at.isoformat()
    return {key: value for key, value in snapshot.items() if value is not None}


@router.get("/zones")
async def zones(context: CloudContext, user: UserDep, db: Db):
    project, token, approval = context
    rows = await get_zones(db, user, token, project, approval)
    return {"items": rows, "total": len(rows), "page": 1, "page_size": 200}


@router.get("/servers")
async def servers(context: CloudContext, user: UserDep, db: Db, page: int = 1, page_size: int = 20):
    project, token, approval = context
    data, _ = await cloud_v1.list_resource(
        db,
        user,
        token,
        project,
        "servers",
        page,
        min(page_size, settings.PAGE_SIZE_MAX),
        approval=approval,
    )
    zone_map = {
        z["id"]: z.get("display_name", z.get("name"))
        for z in await get_zones(db, user, token, project, approval)
    }
    for item in data.get("results", []):
        item["zone_display_name"] = zone_map.get(item.get("zone"), item.get("zone"))
    return page_payload(data, page, page_size)


@router.post("/servers", status_code=201)
async def create_server(
    body: dict[str, Any], context: CloudContext, user: Admin, _csrf: Csrf, db: Db
):
    """Create a server through the common Cloud gateway and audit pipeline."""
    project, token, approval = context
    data, upstream_status = await cloud_v1.create_resource(
        db, user, token, project, "servers", body, approval
    )
    # The upstream may return either an object or a one-item list.
    return {
        "item": data[0] if isinstance(data, list) and data else data,
        "upstream_status": upstream_status,
    }


def _inventory_row(row: ServerInventorySnapshot) -> dict[str, Any]:
    snapshot = _inventory_snapshot(row)
    inventory_status = row.inventory_status
    return {
        "id": row.id,
        "server_id": row.server_id,
        "server_name": row.server_name,
        "refreshed_at": row.refreshed_at,
        "power_state": "deleted" if inventory_status == "deleted" else row.power_state,
        "inventory_status": inventory_status,
        "zone": (row.mapped_references or {}).get("zone", row.zone),
        "private_ip": row.private_ip or [],
        "private_subnets": row.private_subnets or [],
        "elastic_ip": row.elastic_ip or [],
        "snapshot": snapshot,
    }


def _all_inventory_row(row: AllServerInventorySnapshot) -> dict[str, Any]:
    return {
        "id": row.id, "server_id": row.server_id, "server_name": row.server_name,
        "refreshed_at": db_iso(row.refreshed_at),
        "power_state": "deleted" if row.inventory_status == "deleted" else row.power_state,
        "inventory_status": row.inventory_status, "zone": row.zone_name or row.zone,
        "private_ip": row.private_ip or [], "vip_ip": row.vip_ip or [],
        "elastic_ip": row.elastic_ip or [],
        "elastic_vip_ip": row.elastic_vip_ip or [],
    }


async def _all_project_servers(db, user, token, project, approval):
    rows: list[dict[str, Any]] = []
    page = 1
    while True:
        payload, _ = await cloud_v1.list_resource(
            db, user, token, project, "servers", page, 200, approval=approval
        )
        batch = payload.get("results", [])
        rows.extend(batch)
        if not payload.get("next") or not batch:
            return rows
        page += 1


@router.get("/server-inventory")
async def server_inventory(context: CloudContext, user: UserDep, db: Db):
    project, _token, _approval = context
    rows = (
        await db.scalars(
            select(ServerInventorySnapshot)
            .where(ServerInventorySnapshot.project_id == project)
            .order_by(ServerInventorySnapshot.server_name, ServerInventorySnapshot.server_id)
        )
    ).all()
    return {"items": [_inventory_row(row) for row in rows], "total": len(rows)}


def _cloud_rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        rows = payload.get("results", payload.get("items", []))
        return [item for item in rows if isinstance(item, dict)] if isinstance(rows, list) else []
    return [item for item in payload if isinstance(item, dict)] if isinstance(payload, list) else []


async def _accessible_projects(db, user, token, approval) -> list[dict[str, str]]:
    """Combine direct and organization project access, de-duplicated by project ID."""
    projects: dict[str, dict[str, str]] = {}
    direct, _ = await cloud_v1.projects(db, user, token, 1, 500, None, None, approval)
    for item in _cloud_rows(direct):
        project_id = str(item.get("id") or "")
        if project_id:
            projects[project_id] = {
                "id": project_id,
                "name": str(item.get("name") or project_id),
                "display_name": str(item.get("display_name") or item.get("name") or project_id),
                "organization": str(item.get("organization_name") or "Personal"),
            }
    organizations, _ = await cloud_v1.organizations(db, user, token, 1, 500, approval)
    for organization in _cloud_rows(organizations):
        organization_id = str(organization.get("id") or "")
        if not organization_id:
            continue
        payload, _ = await cloud_v1.projects(db, user, token, 1, 500, organization_id, None, approval)
        for item in _cloud_rows(payload):
            project_id = str(item.get("id") or "")
            if project_id:
                projects[project_id] = {
                    "id": project_id,
                    "name": str(item.get("name") or project_id),
                    "display_name": str(item.get("display_name") or item.get("name") or project_id),
                    "organization": str(organization.get("display_name") or organization.get("name") or "Organization"),
                }
    return sorted(projects.values(), key=lambda item: item["name"].lower())


async def _all_project_server_rows(db, user, token, project_id: str, approval) -> list[dict[str, Any]]:
    """Read a complete server inventory in bounded pages without one huge response."""
    rows: list[dict[str, Any]] = []
    page = 1
    # 500 is the Cloud API's requested page size.  The guard also prevents a
    # malformed upstream pagination response from keeping a sync worker alive.
    while page <= 1_000:
        payload, _ = await cloud_v1.list_resource(
            db, user, token, project_id, "servers", page, 500, approval=approval
        )
        batch = _cloud_rows(payload)
        rows.extend(batch)
        if len(batch) < 500:
            break
        page += 1
    return rows


def _all_inventory_sql_predicates(statement: str) -> tuple[list[Any], str | None, bool | None]:
    """Parse a deliberately small, read-only SQL-like search expression."""
    prefix = re.match(r"^\s*select\s+\*\s+from\s+all_server_inventory_snapshots\b", statement, flags=re.IGNORECASE)
    if not prefix:
        raise HTTPException(400, "SQL search only supports SELECT * FROM all_server_inventory_snapshots [WHERE field = 'value'] [ORDER BY field ASC|DESC]")
    tail = statement[prefix.end():].strip().rstrip(";").strip()
    fields = {
        "server_name": AllServerInventorySnapshot.server_name,
        "project_id": AllServerInventorySnapshot.project_id,
        "project_name": AllServerInventorySnapshot.project_name,
        "project_display_name": AllServerInventorySnapshot.project_display_name,
        "zone": AllServerInventorySnapshot.zone,
        "zone_name": AllServerInventorySnapshot.zone_name,
        "region": AllServerInventorySnapshot.region,
        "power_state": AllServerInventorySnapshot.power_state,
        "status": AllServerInventorySnapshot.status,
        "server_id": AllServerInventorySnapshot.server_id,
        "server_type": AllServerInventorySnapshot.server_type,
        "bandwidth": AllServerInventorySnapshot.bandwidth,
        "flavor_name": AllServerInventorySnapshot.flavor_name,
        "image_name": AllServerInventorySnapshot.image_name,
        "enable_ipv4": AllServerInventorySnapshot.enable_ipv4,
        "enable_elastic_ip": AllServerInventorySnapshot.enable_elastic_ip,
        "cloud_created_at": AllServerInventorySnapshot.cloud_created_at,
        "cloud_updated_at": AllServerInventorySnapshot.cloud_updated_at,
        "refreshed_at": AllServerInventorySnapshot.refreshed_at,
        "elastic_vip_ip": cast(AllServerInventorySnapshot.elastic_vip_ip, String),
        "inventory_status": AllServerInventorySnapshot.inventory_status,
    }
    predicates: list[Any] = []
    where = ""
    order_field = None
    order_desc = None
    if tail:
        order_match = re.search(r"(?:^|\s+)order\s+by\s+(\w+)(?:\s+(asc|desc))?\s*$", tail, flags=re.IGNORECASE)
        if order_match:
            order_field = order_match.group(1).lower()
            order_desc = (order_match.group(2) or "asc").lower() == "desc"
            tail = tail[:order_match.start()].strip()
        if tail:
            where_match = re.fullmatch(r"where\s+(.+)", tail, flags=re.IGNORECASE)
            if not where_match:
                raise HTTPException(400, "SQL may contain only WHERE and ORDER BY after the approved SELECT statement")
            where = where_match.group(1)
    if where:
        for clause in re.split(r"\s+and\s+", where, flags=re.IGNORECASE):
            condition = re.fullmatch(
                r'\s*(\w+)\s*(=|!=|<>|<=|>=|<|>|like)\s*(?:\'([^\']*)\'|"([^"]*)"|([^\s]+))\s*',
                clause,
                flags=re.IGNORECASE,
            )
            if not condition or condition.group(1).lower() not in fields:
                raise HTTPException(400, "SQL WHERE supports approved columns with =, !=, <, <=, >, >= or LIKE")
            column = fields[condition.group(1).lower()]
            value = next((item for item in condition.groups()[2:] if item is not None), "")
            operator = condition.group(2).lower()
            if operator == "like":
                predicates.append(column.ilike(value))
            elif operator == "=":
                predicates.append(column == value)
            elif operator in {"!=", "<>"}:
                predicates.append(column != value)
            elif operator == "<":
                predicates.append(column < value)
            elif operator == "<=":
                predicates.append(column <= value)
            elif operator == ">":
                predicates.append(column > value)
            else:
                predicates.append(column >= value)
    if order_field and order_field not in fields:
        raise HTTPException(400, "SQL ORDER BY uses an unsupported column")
    return predicates, order_field, order_desc


@router.get("/all-server-inventory/project-options")
async def all_server_inventory_project_options(user: Operator, db: Db):
    rows = (await db.execute(
        select(
            AllServerInventorySnapshot.project_id,
            func.max(AllServerInventorySnapshot.project_name),
            func.max(AllServerInventorySnapshot.project_display_name),
        ).where(AllServerInventorySnapshot.project_id != "")
        .group_by(AllServerInventorySnapshot.project_id)
    )).all()
    items = [{"id": project_id, "name": name or project_id, "display_name": display_name or name or project_id}
             for project_id, name, display_name in rows]
    items.sort(key=lambda item: (item["display_name"].casefold(), item["id"]))
    return {"items": items, "total": len(items)}


@router.get("/all-server-inventory/projects")
async def all_server_inventory_projects(
    context: BootstrapContext, user: Operator, db: Db
):
    token, approval = context
    items = [dict(item) for item in await _accessible_projects(db, user, token, approval)]
    project_ids = [item["id"] for item in items]
    inventory_times = {}
    sync_times = {}
    if project_ids:
        inventory_times = dict((await db.execute(
            select(AllServerInventorySnapshot.project_id, func.max(AllServerInventorySnapshot.refreshed_at))
            .where(AllServerInventorySnapshot.project_id.in_(project_ids))
            .group_by(AllServerInventorySnapshot.project_id)
        )).all())
        # Successful audits also cover projects synchronized with zero VMs.
        sync_times = dict((await db.execute(
            select(AuditLog.project_id, func.max(AuditLog.created_at))
            .where(
                AuditLog.project_id.in_(project_ids),
                AuditLog.action == "all_server_inventory.sync_project",
                AuditLog.result == "success",
            ).group_by(AuditLog.project_id)
        )).all())
    for item in items:
        timestamps = [value for value in (
            inventory_times.get(item["id"]), sync_times.get(item["id"])
        ) if value is not None]
        item["is_synced"] = bool(timestamps)
        item["last_synced_at"] = db_iso(max(timestamps)) if timestamps else None
    items.sort(key=lambda item: (
        item["is_synced"], (item.get("display_name") or item.get("name") or "").casefold(), item["id"]
    ))
    return {"items": items, "total": len(items)}


@router.post("/all-server-inventory/sync-project")
async def sync_all_server_inventory_project(
    body: dict[str, Any] | None,
    context: BootstrapContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Sync one permitted project; the browser controls bounded cross-project concurrency."""
    token, approval = context
    project_id = str((body or {}).get("project_id") or "").strip()
    project_name = str((body or {}).get("project_name") or project_id).strip() or project_id
    if not project_id:
        raise HTTPException(400, "project_id is required")
    permitted = {item["id"]: item for item in await _accessible_projects(db, user, token, approval)}
    if project_id not in permitted:
        raise HTTPException(403, "The selected project is not available to this cloud authorization")
    # Take the gateway's canonical display name instead of accepting a name
    # supplied by the browser.
    project_name = permitted[project_id]["name"]
    project_display_name = permitted[project_id]["display_name"]
    servers = await _all_project_server_rows(db, user, token, project_id, approval)
    elastic_ips = await _project_elastic_ips(db, user, token, project_id, approval) if any(
        server.get("elastic_ip") or server.get("elastic_ips") for server in servers
    ) else {}
    zone_labels = {
        str(item.get("id")): str(item.get("display_name") or item.get("name") or item.get("id"))
        for item in await get_zones(db, user, token, project_id, approval)
        if item.get("id")
    }
    live_ids = {str(item.get("id")) for item in servers if item.get("id")}
    refreshed_at = db_now()
    stored = (await db.scalars(select(AllServerInventorySnapshot).where(AllServerInventorySnapshot.project_id == project_id))).all()
    by_server_id = {row.server_id: row for row in stored}
    for row in stored:
        if row.server_id not in live_ids:
            row.inventory_status = "deleted"
            row.deleted_at = refreshed_at
            row.refreshed_at = refreshed_at
            row.project_name = project_name
            row.project_display_name = project_display_name
    for server in servers:
        server_id = str(server.get("id") or "")
        if not server_id:
            continue
        snapshot = _snapshot_server_detail(dict(server), {})
        zone_id = str(snapshot.get("zone") or "")
        snapshot["zone_name"] = zone_labels.get(zone_id, zone_id)
        snapshot["inventory_status"] = "active"
        snapshot["user_data"] = str(snapshot.get("user_data") or "")[:100]
        values = _all_inventory_values(snapshot, elastic_ips)
        row = by_server_id.get(server_id)
        if row is None:
            db.add(AllServerInventorySnapshot(
                project_id=project_id, project_name=project_name, project_display_name=project_display_name, server_id=server_id,
                server_name=str(server.get("name") or ""), zone_name=snapshot.get("zone_name"), refreshed_at=refreshed_at, **values,
            ))
        else:
            row.project_name = project_name
            row.project_display_name = project_display_name
            row.server_name = str(server.get("name") or row.server_name)
            row.zone_name = zone_labels.get(str(server.get("zone") or ""), str(server.get("zone") or ""))
            row.refreshed_at = refreshed_at
            for field, value in values.items():
                setattr(row, field, value)
    await db.commit()
    await write_audit(
        db, user, "all_server_inventory.sync_project", "success",
        project_id=project_id, target_type="server_inventory",
        metadata={"project_name": project_name, "project_display_name": project_display_name, "servers": len(servers)},
    )
    return {
        "project_id": project_id, "project_name": project_name, "status": "succeeded",
        "servers": len(servers), "last_synced_at": db_iso(refreshed_at),
    }


@router.post("/all-server-inventory/refresh-servers")
async def refresh_all_server_inventory_servers(
    body: dict[str, Any] | None,
    context: BootstrapContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Refresh only selected VMs; unlike project sync this never marks rows deleted."""
    token, approval = context
    requested = (body or {}).get("items") or []
    if not isinstance(requested, list) or not requested:
        raise HTTPException(400, "Select at least one server to refresh")
    permitted = {item["id"]: item for item in await _accessible_projects(db, user, token, approval)}
    zone_maps: dict[str, dict[str, str]] = {}
    elastic_ip_maps: dict[str, dict[str, dict[str, Any]]] = {}
    results: list[dict[str, Any]] = []
    refreshed_at = db_now()
    for item in requested:
        project_id = str((item or {}).get("project_id") or "")
        server_id = str((item or {}).get("server_id") or "")
        if not project_id or not server_id:
            continue
        if project_id not in permitted:
            results.append({"project_id": project_id, "server_id": server_id, "status": "failed", "error": "Project is not available"})
            continue
        try:
            if project_id not in zone_maps:
                zone_maps[project_id] = {
                    str(zone.get("id")): str(zone.get("display_name") or zone.get("name") or zone.get("id"))
                    for zone in await get_zones(db, user, token, project_id, approval)
                    if zone.get("id")
                }
            detail, _ = await cloud_v1.call(
                db, user, token, "GET", f"/legacy/api/infra/servers/{server_id}/",
                project_id, approval=approval,
            )
            snapshot = _snapshot_server_detail(dict(detail or {}), {})
            if project_id not in elastic_ip_maps and (snapshot.get("elastic_ip") or snapshot.get("elastic_ips")):
                elastic_ip_maps[project_id] = await _project_elastic_ips(db, user, token, project_id, approval)
            zone_id = str(snapshot.get("zone") or "")
            snapshot["zone_name"] = zone_maps[project_id].get(zone_id, zone_id)
            snapshot["inventory_status"] = "active"
            snapshot["user_data"] = str(snapshot.get("user_data") or "")[:100]
            values = _all_inventory_values(snapshot, elastic_ip_maps.get(project_id, {}))
            row = await db.scalar(select(AllServerInventorySnapshot).where(
                AllServerInventorySnapshot.project_id == project_id,
                AllServerInventorySnapshot.server_id == server_id,
            ))
            project = permitted[project_id]
            if row is None:
                row = AllServerInventorySnapshot(
                    project_id=project_id, project_name=project["name"],
                    project_display_name=project["display_name"], server_id=server_id,
                    server_name=str(snapshot.get("name") or ""), zone_name=snapshot.get("zone_name"),
                    refreshed_at=refreshed_at, **values,
                )
                db.add(row)
            else:
                row.project_name = project["name"]
                row.project_display_name = project["display_name"]
                row.server_name = str(snapshot.get("name") or row.server_name)
                row.zone_name = snapshot.get("zone_name")
                row.refreshed_at = refreshed_at
                for field, value in values.items():
                    setattr(row, field, value)
            results.append({"project_id": project_id, "server_id": server_id, "status": "succeeded"})
        except HTTPException as exc:
            results.append({"project_id": project_id, "server_id": server_id, "status": "failed", "error": exc.detail})
    await db.commit()
    await write_audit(
        db, user, "all_server_inventory.refresh_servers",
        "success" if all(item["status"] == "succeeded" for item in results) else "partial",
        target_type="all_server_inventory", metadata={"requested": len(requested), "results": results},
    )
    return {"items": results, "total": len(results)}


@router.get("/all-server-inventory/servers/{project_id}/{server_id}")
async def all_server_inventory_server_detail(
    project_id: str,
    server_id: str,
    context: BootstrapContext,
    user: UserDep,
    db: Db,
    include_network_details: bool = False,
):
    """Read live server detail in the selected record's project context."""
    token, approval = context
    permitted = {item["id"] for item in await _accessible_projects(db, user, token, approval)}
    if project_id not in permitted:
        raise HTTPException(403, "The selected project is not available to this cloud authorization")
    detail = await server_detail(
        server_id, (project_id, token, approval), user, db,
        include_network_details=include_network_details,
    )
    references = await _inventory_reference_maps(db, user, token, project_id, approval)
    snapshot = _snapshot_server_detail(dict(detail or {}), references)
    # This is an explicit live-detail view, unlike the compact inventory cache.
    # Keep full user data available to the operator in the modal.
    if "user_data" in detail:
        snapshot["user_data"] = detail["user_data"]
    elif "userData" in detail:
        snapshot["user_data"] = detail["userData"]
    return {"item": snapshot}


@router.post("/all-server-inventory/servers/{project_id}/{server_id}/console")
async def all_server_inventory_server_console(
    project_id: str,
    server_id: str,
    context: BootstrapContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Open a VM console using the project recorded for an All Servers row."""
    token, approval = context
    permitted = {item["id"] for item in await _accessible_projects(db, user, token, approval)}
    if project_id not in permitted:
        raise HTTPException(403, "The selected project is not available to this cloud authorization")

    # Fetch the live VM first so a stale or tampered inventory row cannot open a
    # console for a server outside this project.
    detail, _ = await cloud_v1.call(
        db, user, token, "GET", f"/legacy/api/infra/servers/{server_id}/",
        project_id, approval=approval,
    )
    if detail.get("project") != project_id:
        raise HTTPException(403, "Project mismatch")
    data, _ = await cloud_v1.call(
        db, user, token, "POST", f"/legacy/api/infra/servers/{server_id}/console/",
        project_id, body={}, approval=approval,
    )
    url = data.get("url", "")
    parsed = urlsplit(url)
    allowed_schemes = {"https"} if settings.APP_ENV == "production" else {"http", "https"}
    if (
        parsed.scheme not in allowed_schemes
        or parsed.hostname not in settings.CLOUD_API_ALLOWED_HOSTS
    ):
        raise HTTPException(502, "Unsafe console URL returned by Cloud API")
    await write_audit(
        db,
        user,
        "server.console.open",
        "success",
        project_id=project_id,
        target_type="server",
        target_id=server_id,
    )
    ticket = _issue_console_ticket(_console_websocket_url(url))
    return {
        "url": url,
        "websocket_path": f"/cloud/console-proxy/{ticket}",
    }


@router.post("/all-server-inventory/servers/{project_id}/{server_id}/change-password")
async def all_server_inventory_server_change_password(
    project_id: str,
    server_id: str,
    payload: PasswordBatch,
    context: BootstrapContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Change one inventory VM password in the VM's own project context."""
    token, approval = context
    permitted = {item["id"] for item in await _accessible_projects(db, user, token, approval)}
    if project_id not in permitted:
        raise HTTPException(403, "The selected project is not available to this cloud authorization")
    if payload.server_ids != [server_id]:
        raise HTTPException(422, "The password target must match the selected server")

    profile = await db.get(PasswordProfile, payload.profile_id) if payload.profile_id else None
    if payload.profile_id and (not profile or not profile.is_active):
        raise HTTPException(404, "Password profile not found")
    password = decrypt_profile(profile) if profile else payload.password
    if not password:
        raise HTTPException(422, "Password is required")

    detail, _ = await cloud_v1.call(
        db, user, token, "GET", f"/legacy/api/infra/servers/{server_id}/",
        project_id, approval=approval,
    )
    if detail.get("project") != project_id:
        raise HTTPException(403, "Project mismatch")
    try:
        _, code = await cloud_v1.call(
            db, user, token, "POST",
            f"/legacy/api/infra/servers/{server_id}/change-password/",
            project_id, body={"new_password": password}, approval=approval,
        )
        result = {"server_id": server_id, "status": "accepted" if code == 202 else "completed"}
    except HTTPException as exc:
        result = {"server_id": server_id, "status": "failed", "error": str(exc.detail)}
    password = ""
    await write_audit(
        db, user, "server.password.change", result["status"], project_id=project_id,
        target_type="server", target_id=server_id,
        metadata={"password_source": "profile" if profile else "custom", **({"profile_id": profile.id} if profile else {})},
    )
    return {"items": [result]}


@router.get("/all-server-inventory")
async def all_server_inventory(
    context: BootstrapContext,
    user: Operator,
    db: Db,
    page: int = 1,
    page_size: int = 50,
    q: str | None = None,
    project_id: str | None = None,
    project_ids: str | None = None,
    server_name: str | None = None,
    project_name: str | None = None,
    private_ip: str | None = None,
    elastic_ip: str | None = None,
    elastic_vip_ip: str | None = None,
    zone: str | None = None,
    power_state: str | None = None,
    ip_match: str = "contains",
    batch_fields: str | None = None,
    batch_values: str | None = None,
    sql_query: str | None = None,
    sort_by: str = "refreshed_at",
    sort_desc: bool = True,
):
    _token, _approval = context
    # Apply before every search and pagination path, including SQL and export.
    predicates = [
        func.lower(func.coalesce(column, "")).notin_(["deleted"])
        for column in (
            AllServerInventorySnapshot.inventory_status,
            AllServerInventorySnapshot.power_state,
            AllServerInventorySnapshot.status,
        )
    ]
    predicates.append(AllServerInventorySnapshot.deleted_at.is_(None))
    if project_id:
        predicates.append(AllServerInventorySnapshot.project_id == project_id)
    if project_ids:
        selected_projects = list(dict.fromkeys(value.strip() for value in project_ids.split(",") if value.strip()))
        if selected_projects:
            predicates.append(AllServerInventorySnapshot.project_id.in_(selected_projects))
    if q and q.strip():
        value = f"%{q.strip()}%"
        predicates.append(or_(
            AllServerInventorySnapshot.server_name.ilike(value),
            AllServerInventorySnapshot.project_name.ilike(value),
            AllServerInventorySnapshot.server_id.ilike(value),
            AllServerInventorySnapshot.power_state.ilike(value),
            AllServerInventorySnapshot.zone.ilike(value),
            cast(AllServerInventorySnapshot.elastic_vip_ip, String).ilike(value),
        ))
    for value, column in (
        (server_name, AllServerInventorySnapshot.server_name),
        (project_name, AllServerInventorySnapshot.project_name),
        (zone, func.coalesce(func.nullif(AllServerInventorySnapshot.zone_name, ""), AllServerInventorySnapshot.zone)),
        (power_state, case(
            (AllServerInventorySnapshot.inventory_status == "deleted", "deleted"),
            else_=AllServerInventorySnapshot.power_state,
        )),
    ):
        if value and value.strip():
            predicates.append(column.ilike(f"%{value.strip()}%"))
    if private_ip and private_ip.strip():
        value = f"%{private_ip.strip()}%"
        predicates.append(or_(
            cast(AllServerInventorySnapshot.private_ip, String).ilike(value),
            cast(AllServerInventorySnapshot.vip_ip, String).ilike(value),
        ))
    if elastic_ip and elastic_ip.strip():
        predicates.append(
            or_(
                cast(AllServerInventorySnapshot.elastic_ip, String).ilike(f"%{elastic_ip.strip()}%"),
                cast(AllServerInventorySnapshot.elastic_vip_ip, String).ilike(f"%{elastic_ip.strip()}%"),
            )
        )
    if elastic_vip_ip and elastic_vip_ip.strip():
        predicates.append(cast(AllServerInventorySnapshot.elastic_vip_ip, String).ilike(f"%{elastic_vip_ip.strip()}%"))
    if batch_values and batch_values.strip():
        supported = {
            "server_name": AllServerInventorySnapshot.server_name,
            "project_name": AllServerInventorySnapshot.project_name,
            "zone_name": AllServerInventorySnapshot.zone_name,
            "power_state": AllServerInventorySnapshot.power_state,
            "server_id": AllServerInventorySnapshot.server_id,
            "private_ip": AllServerInventorySnapshot.private_ip,
            "vip_ip": AllServerInventorySnapshot.vip_ip,
            "elastic_ip": AllServerInventorySnapshot.elastic_ip,
            "elastic_vip_ip": AllServerInventorySnapshot.elastic_vip_ip,
        }
        ip_fields = {"private_ip", "vip_ip", "elastic_ip", "elastic_vip_ip"}
        fields = [field.strip() for field in (batch_fields or "server_name").split(",") if field.strip()]
        if not fields or any(field not in supported for field in fields):
            raise HTTPException(400, "Batch fields must be server_name, project_name, zone_name, power_state, server_id, private_ip, vip_ip, elastic_ip or elastic_vip_ip")
        if ip_match not in {"contains", "exact"}:
            raise HTTPException(400, "ip_match must be contains or exact")

        def batch_predicate(field: str, value: str):
            if field not in ip_fields:
                return supported[field].ilike(f"%{value}%")
            pattern = f'%"{value}"%' if ip_match == "exact" else f"%{value}%"
            if field == "elastic_ip":
                return or_(cast(supported[field], String).ilike(pattern),
                           cast(AllServerInventorySnapshot.elastic_vip_ip, String).ilike(pattern))
            return cast(supported[field], String).ilike(pattern)

        batch_rows = []
        for line in batch_values.splitlines():
            values = [value.strip() for value in line.split(",")]
            if not any(values):
                continue
            if len(values) != len(fields):
                raise HTTPException(400, f"Batch line '{line}' must have {len(fields)} comma-separated value(s)")
            batch_rows.append(and_(*[batch_predicate(field, value) for field, value in zip(fields, values)]))
        if batch_rows:
            predicates.append(or_(*batch_rows))
    sql_order = None
    sql_desc = None
    if sql_query and sql_query.strip():
        sql_predicates, sql_order, sql_desc = _all_inventory_sql_predicates(sql_query.strip())
        predicates.extend(sql_predicates)
    allowed = {"server_name", "project_name", "project_display_name", "power_state", "zone", "zone_name", "region", "status", "refreshed_at", "server_id", "server_type", "bandwidth", "flavor_name", "image_name", "cloud_created_at", "cloud_updated_at", "inventory_status"}
    if sql_order:
        sort_by, sort_desc = sql_order, bool(sql_desc)
    order = getattr(AllServerInventorySnapshot, sort_by if sort_by in allowed else "refreshed_at")
    query = select(AllServerInventorySnapshot).where(*predicates)
    total = await db.scalar(select(func.count()).select_from(AllServerInventorySnapshot).where(*predicates)) or 0
    rows = (await db.scalars(query.order_by(order.desc() if sort_desc else order.asc()).offset((max(page, 1) - 1) * min(max(page_size, 1), 500)).limit(min(max(page_size, 1), 500)))).all()
    return {
        "items": [{**_all_inventory_row(row), "project_id": row.project_id, "project_name": row.project_name, "project_display_name": row.project_display_name} for row in rows],
        "total": total, "page": max(page, 1), "page_size": min(max(page_size, 1), 500),
    }


@router.post("/all-server-inventory/sql-search")
async def all_server_inventory_sql_search(
    body: dict[str, Any] | None,
    context: BootstrapContext,
    user: UserDep,
    _csrf: Csrf,
    db: Db,
):
    """Dedicated POST-only, validated SQL-like lookup for the All servers table."""
    payload = body or {}
    statement = str(payload.get("sql_query") or "").strip()
    if not statement:
        raise HTTPException(400, "sql_query is required")
    return await all_server_inventory(
        context=context,
        user=user,
        db=db,
        page=int(payload.get("page") or 1),
        page_size=int(payload.get("page_size") or 50),
        sort_by=str(payload.get("sort_by") or "refreshed_at"),
        sort_desc=bool(payload.get("sort_desc", True)),
        sql_query=statement,
        project_ids=str(payload.get("project_ids") or ""),
    )


def _dolphin_ip_values(value: Any) -> list[str]:
    values = value if isinstance(value, list) else [value]
    result = []
    for item in values:
        if isinstance(item, dict):
            item = item.get("ip_address") or item.get("address")
        if item:
            result.append(str(item))
    return list(dict.fromkeys(result))


def _dolphin_vip_values(private_ips: Any) -> list[str]:
    """Flatten VIPs while retaining their source private-IP ordering upstream."""
    values = private_ips if isinstance(private_ips, list) else [private_ips]
    result: list[str] = []
    for private_ip in values:
        if not isinstance(private_ip, dict):
            continue
        result.extend(_dolphin_ip_values(private_ip.get("vips")))
    return list(dict.fromkeys(result))


def _dolphin_inventory_item(
    row: ServerInventorySnapshot,
    system_name: str,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Map one saved inventory record into Dolphin's documented contract."""
    snapshot = _inventory_snapshot(row)
    specs = snapshot.get("specs") if isinstance(snapshot.get("specs"), dict) else {}
    volume_details = snapshot.get("volume_details")
    if not isinstance(volume_details, list):
        volume_details = snapshot.get("volumes") if isinstance(snapshot.get("volumes"), list) else []
    sizes = []
    for volume in volume_details:
        source = volume.get("volume", volume) if isinstance(volume, dict) else {}
        try:
            sizes.append(float(source.get("size") or 0))
        except (TypeError, ValueError):
            continue
    private_ips = _dolphin_ip_values(snapshot.get("private_ip"))
    vip_ips = _dolphin_vip_values(snapshot.get("private_ip"))
    public_ips = _dolphin_ip_values(snapshot.get("elastic_ip"))
    # The server-detail endpoint returns the resolved flavor at the top level
    # (`flavor`), while provisioning requests store it under `specs`.  Inventory
    # records created before the column migration also keep that top-level object
    # in `extra`; `_inventory_snapshot` restores it.  Resolve all of these
    # shapes so Dolphin never loses CPU/RAM for an existing VM.
    flavor = (
        snapshot.get("flavor")
        if isinstance(snapshot.get("flavor"), dict)
        else (
            specs.get("flavor")
            if isinstance(specs.get("flavor"), dict)
            else {}
        )
    )
    flavor_name = str(
        snapshot.get("flavor_name")
        or specs.get("flavor_name")
        or flavor.get("flavor_name")
        or flavor.get("name")
        or flavor.get("display_name")
        or ""
    )
    flavor_match = re.search(r"(\d+)\s*C\D+(\d+)\s*GB", flavor_name, re.I)
    vcpu = (
        specs.get("vcpus")
        or specs.get("vcpu")
        or flavor.get("vcpus")
        or flavor.get("vcpu")
        or snapshot.get("vcpus")
    )
    ram_gb = (
        specs.get("ram_gb")
        or specs.get("ram")
        or flavor.get("ram_gb")
        or flavor.get("ram")
        or snapshot.get("ram_gb")
        or snapshot.get("ram")
    )
    try:
        ram_gb = float(ram_gb) if ram_gb is not None else None
        # Cloud API flavors sometimes express RAM in MiB; Dolphin needs GiB.
        if ram_gb and ram_gb >= 1024 and ram_gb.is_integer():
            ram_gb = int(ram_gb // 1024)
        elif ram_gb and ram_gb.is_integer():
            ram_gb = int(ram_gb)
    except (TypeError, ValueError):
        ram_gb = None
    item: dict[str, Any] = {
        "external_id": row.server_id,
        "system_name": system_name,
        "vm_name": row.server_name,
        "management_ip": (private_ips or public_ips or [""])[0],
        "private_ip": ",".join(private_ips),
        "vip_ip": ",".join(vip_ips),
        "public_ip": ",".join(public_ips),
        "flavor_name": flavor_name,
        "vcpu": vcpu or (int(flavor_match.group(1)) if flavor_match else None),
        "ram_gb": ram_gb or (int(flavor_match.group(2)) if flavor_match else None),
        "storage_total_gb": int(sum(sizes)) if sizes else None,
        "storage_detail": volume_details or None,
        "os_name": snapshot.get("image_name"),
        "project_name": row.project_id,
        "deployment_site": "PUBLIC_CLOUD",
        "deployment_position": "Public_cloud",
    }
    editable = {
        "system_name", "owner_unit", "product_owner", "deployment_site",
        "deployment_position", "management_ip", "private_ip", "vip_ip", "public_ip",
        "vcpu", "ram_gb", "storage_total_gb", "storage_detail", "os_name",
        "vm_name", "project_name",
    }
    for key, value in (overrides or {}).items():
        if key in editable:
            item[key] = value
    return {
        key: value
        for key, value in item.items()
        if value is not None and value != "" and value != []
    }


@router.post("/server-inventory/dolphin-preview")
async def preview_server_inventory_for_dolphin(
    body: dict[str, Any] | None,
    context: CloudContext,
    user: Operator,
    db: Db,
):
    """Build editable Dolphin payloads only from locally saved inventory."""
    project, _token, _approval = context
    server_ids = [str(item) for item in (body or {}).get("server_ids", []) if str(item)]
    system_name = str((body or {}).get("system_name") or "").strip()
    if not server_ids or not system_name:
        raise HTTPException(400, "server_ids and system_name are required")
    rows = (
        await db.scalars(
            select(ServerInventorySnapshot).where(
                ServerInventorySnapshot.project_id == project,
                ServerInventorySnapshot.server_id.in_(server_ids),
            )
        )
    ).all()
    by_id = {row.server_id: row for row in rows}
    items = []
    for server_id in server_ids:
        row = by_id.get(server_id)
        if not row:
            items.append({"external_id": server_id, "error": "Server inventory record was not found"})
            continue
        item = _dolphin_inventory_item(row, system_name)
        private_ips = _dolphin_ip_values(_inventory_snapshot(row).get("private_ip"))
        # Teleport/monitor addresses are preferred for management when present.
        preferred = next((ip for ip in private_ips if ip.startswith("10.129.")), "")
        item["management_ip"] = preferred
        item["private_ip_options"] = private_ips
        item["server_name"] = row.server_name
        items.append(item)
    return {"items": items}


@router.post("/server-inventory/dolphin-records")
async def list_server_inventory_dolphin_records(
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Reconcile this project's saved VM IDs with their Dolphin records."""
    project, _token, _approval = context
    rows = (
        await db.scalars(
            select(ServerInventorySnapshot)
            .where(
                ServerInventorySnapshot.project_id == project,
                ServerInventorySnapshot.inventory_status != "deleted",
            )
            .order_by(ServerInventorySnapshot.server_name, ServerInventorySnapshot.server_id)
        )
    ).all()
    items: list[dict[str, Any]] = []
    failed = 0
    for start in range(0, len(rows), 500):
        batch_rows = rows[start : start + 500]
        try:
            response = await ingest_resources(
                "lookup", [{"external_id": row.server_id} for row in batch_rows]
            )
            response_by_id = {
                str(result.get("external_id")): result
                for result in response.get("results", [])
                if isinstance(result, dict) and result.get("external_id")
            }
            for row in batch_rows:
                result = response_by_id.get(row.server_id)
                if not result:
                    failed += 1
                    items.append({
                        "server_id": row.server_id,
                        "server_name": row.server_name,
                        "dolphin_status": "error",
                        "error": "Dolphin returned no lookup result for this server",
                    })
                    continue
                detail = result.get("resource") or result.get("item") or {}
                detail = detail if isinstance(detail, dict) else {}
                status = str(result.get("status") or "unknown").lower()
                if status == "error":
                    failed += 1
                items.append({
                    "server_id": row.server_id,
                    "server_name": row.server_name,
                    "power_state": row.power_state,
                    "inventory_status": row.inventory_status,
                    "dolphin_status": status,
                    **detail,
                    **result,
                })
        except HTTPException as exc:
            failed += len(batch_rows)
            error = _upstream_error_detail(exc.detail)
            items.extend(
                {
                    "server_id": row.server_id,
                    "server_name": row.server_name,
                    "power_state": row.power_state,
                    "inventory_status": row.inventory_status,
                    "dolphin_status": "error",
                    "error": error,
                }
                for row in batch_rows
            )
    await write_audit(
        db, user, "server.inventory.dolphin_lookup",
        "success" if not failed else "partial",
        project_id=project, target_type="server_inventory",
        metadata={"requested": len(rows), "failed": failed},
    )
    return {"items": items, "summary": {"requested": len(rows), "failed": failed}}


@router.post("/server-inventory/dolphin-sync")
async def sync_server_inventory_to_dolphin(
    payload: DolphinInventorySync,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Push selected stored inventory rows to Dolphin in safe batches of 500."""
    project, _token, _approval = context
    submitted = {str(item.get("external_id")): item for item in payload.items if item.get("external_id")}
    server_ids = list(dict.fromkeys(payload.server_ids + list(submitted)))
    rows = (
        await db.scalars(
            select(ServerInventorySnapshot).where(
                ServerInventorySnapshot.project_id == project,
                ServerInventorySnapshot.server_id.in_(server_ids),
            )
        )
    ).all()
    by_id = {row.server_id: row for row in rows}
    outcomes: list[dict[str, Any]] = []
    items: list[dict[str, Any]] = []
    for server_id in server_ids:
        row = by_id.get(server_id)
        if not row:
            outcomes.append({"server_id": server_id, "server_name": "", "status": "error", "error": "Server inventory record was not found"})
            continue
        if payload.action in {"revoke", "lookup"}:
            items.append({"external_id": row.server_id})
        else:
            items.append(_dolphin_inventory_item(row, payload.system_name, submitted.get(server_id)))

    for start in range(0, len(items), 500):
        batch = items[start : start + 500]
        try:
            response = await ingest_resources(payload.action, batch)
            response_by_id = {
                str(item.get("external_id")): item
                for item in response.get("results", [])
                if isinstance(item, dict) and item.get("external_id")
            }
            for item in batch:
                result = response_by_id.get(item["external_id"])
                if result:
                    outcomes.append({"server_id": item["external_id"], "server_name": by_id[item["external_id"]].server_name, **result})
                else:
                    outcomes.append({"server_id": item["external_id"], "server_name": by_id[item["external_id"]].server_name, "status": "error", "error": "Dolphin returned no result for this server"})
        except HTTPException as exc:
            error = _upstream_error_detail(exc.detail)
            outcomes.extend(
                {"server_id": item["external_id"], "server_name": by_id[item["external_id"]].server_name, "status": "error", "error": error}
                for item in batch
            )

    failed = sum(str(item.get("status", "")).lower() == "error" for item in outcomes)
    await write_audit(
        db, user, "server.inventory.dolphin_sync",
        "success" if not failed else "partial",
        project_id=project, target_type="server_inventory",
        metadata={
            "action": payload.action, "system_name": payload.system_name,
            "requested": len(server_ids), "processed": len(outcomes), "failed": failed,
        },
    )
    return {
        "items": outcomes,
        "summary": {"requested": len(server_ids), "processed": len(outcomes), "failed": failed},
    }


@router.get("/server-inventory/targets")
async def server_inventory_targets(
    context: CloudContext,
    user: UserDep,
    db: Db,
    page: int = 1,
    page_size: int = 200,
):
    """Return one small page of current server IDs for client-side refresh batching."""
    project, token, approval = context
    payload, _ = await cloud_v1.list_resource(
        db,
        user,
        token,
        project,
        "servers",
        max(1, page),
        min(max(1, page_size), settings.PAGE_SIZE_MAX),
        approval=approval,
    )
    items = [
        {"server_id": str(item["id"]), "server_name": str(item.get("name") or "")}
        for item in payload.get("results", [])
        if item.get("id")
    ]
    return {
        "items": items,
        "total": int(payload.get("count") or len(items)),
        "page": page,
        "page_size": page_size,
        "has_more": bool(payload.get("next")),
    }


@router.post("/server-inventory/reconcile")
async def reconcile_server_inventory(
    body: dict[str, Any] | None,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Mark stored snapshots deleted after a complete, paginated live-server scan."""
    project, _token, _approval = context
    live_ids = {str(item) for item in (body or {}).get("server_ids", []) if str(item)}
    refreshed_at = db_now()
    rows = (
        await db.scalars(
            select(ServerInventorySnapshot).where(
                ServerInventorySnapshot.project_id == project
            )
        )
    ).all()
    deleted = 0
    for row in rows:
        if row.server_id in live_ids:
            continue
        if row.inventory_status != "deleted":
            deleted += 1
        row.inventory_status = "deleted"
        row.deleted_at = refreshed_at
        row.refreshed_at = refreshed_at
    await db.commit()
    return {"deleted": deleted}


@router.post("/server-inventory/refresh")
async def refresh_server_inventory(
    body: dict[str, Any] | None,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Refresh selected/all server detail snapshots without touching Servers flows."""
    project, token, approval = context
    requested_ids = {
        str(item) for item in (body or {}).get("server_ids", []) if str(item)
    }
    refresh_all = not requested_ids
    # A targeted refresh is intentionally self-contained: the web UI sends
    # small batches so very large projects never wait for one giant request.
    # Only an explicit all-refresh needs the full list for delete reconciliation.
    live_by_id: dict[str, dict[str, Any]] = {}
    if refresh_all:
        live_servers = await _all_project_servers(db, user, token, project, approval)
        live_by_id = {
            str(item.get("id")): item for item in live_servers if item.get("id")
        }
    target_ids = requested_ids or set(live_by_id)
    references = await _inventory_reference_maps(db, user, token, project, approval)
    results: list[dict[str, str]] = []
    refreshed_at = db_now()
    loaded_placement_regions: set[str] = set()

    if refresh_all:
        stored_rows = (
            await db.scalars(
                select(ServerInventorySnapshot).where(
                    ServerInventorySnapshot.project_id == project
                )
            )
        ).all()
        for row in stored_rows:
            if row.server_id in live_by_id:
                continue
            row.inventory_status = "deleted"
            row.deleted_at = refreshed_at
            row.refreshed_at = refreshed_at

    for server_id in target_ids:
        server = live_by_id.get(server_id)
        if refresh_all and server is None:
            row = await db.scalar(
                select(ServerInventorySnapshot).where(
                    ServerInventorySnapshot.project_id == project,
                    ServerInventorySnapshot.server_id == server_id,
                )
            )
            if row:
                row.inventory_status = "deleted"
                row.deleted_at = refreshed_at
                row.refreshed_at = refreshed_at
            results.append({"server_id": server_id, "status": "failed", "error": "Server is not in the current project"})
            continue
        try:
            detail, _ = await cloud_v1.call(
                db, user, token, "GET", f"/legacy/api/infra/servers/{server_id}/",
                project, approval=approval,
            )
            if detail.get("project") != project:
                raise HTTPException(403, "Server does not belong to current project")
            region = detail.get("region_id") or detail.get("region")
            if isinstance(region, dict):
                region = region.get("id")
            if region and str(region) not in loaded_placement_regions:
                references.setdefault("placement_group", {}).update(
                    await _inventory_placement_groups(
                        db, user, token, project, str(region), approval
                    )
                )
                loaded_placement_regions.add(str(region))
            snapshot = _snapshot_server_detail(detail, references)
            snapshot["inventory_status"] = "active"
            snapshot.pop("deleted_at", None)
            values = _inventory_values(snapshot)
            row = await db.scalar(
                select(ServerInventorySnapshot).where(
                    ServerInventorySnapshot.project_id == project,
                    ServerInventorySnapshot.server_id == server_id,
                )
            )
            if row is None:
                row = ServerInventorySnapshot(
                    project_id=project,
                    server_id=server_id,
                    server_name=str(detail.get("name") or (server or {}).get("name") or ""),
                    refreshed_at=refreshed_at,
                    **values,
                )
                db.add(row)
            else:
                row.server_name = str(detail.get("name") or (server or {}).get("name") or "")
                row.refreshed_at = refreshed_at
                for field, value in values.items():
                    setattr(row, field, value)
            results.append({"server_id": server_id, "status": "succeeded"})
        except HTTPException as exc:
            results.append({"server_id": server_id, "status": "failed", "error": str(exc.detail)})
        except Exception as exc:
            # Keep the batch running and report an individual server failure.
            results.append({"server_id": server_id, "status": "failed", "error": str(exc)})

    await db.commit()
    await write_audit(
        db, user, "server.inventory.refresh",
        "success" if all(item["status"] == "succeeded" for item in results) else "partial",
        project_id=project,
        target_type="server_inventory",
        metadata={"requested": len(target_ids), "succeeded": sum(item["status"] == "succeeded" for item in results)},
    )
    return {"items": results, "total": len(results)}


async def _server_network_details(data, db, user, token, project, approval):
    """Resolve attached networks through existing project-scoped, paginated APIs."""
    errors = []

    async def catalog(resource, params=None):
        result = {}
        page = 1
        try:
            while True:
                payload, _ = await cloud_v1.list_resource(
                    db, user, token, project, resource, page, 200,
                    params=params, approval=approval,
                )
                rows = payload.get("results", [])
                result.update({str(row["id"]): row for row in rows if isinstance(row, dict) and row.get("id")})
                if not payload.get("next") or not rows:
                    break
                page += 1
        except HTTPException:
            errors.append(f"Could not load {resource}. Some network details may be unavailable.")
        return result

    def entries(value):
        return value if isinstance(value, list) else [value] if value else []

    def record(value):
        if isinstance(value, dict):
            return value
        try:
            return {"ip_address": str(ipaddress.ip_address(str(value)))}
        except ValueError:
            return {"id": str(value)}

    def vip_addresses(value, lookup):
        result = []
        for vip in entries(value):
            item = record(vip)
            resolved = {**lookup.get(str(item.get("id") or ""), {}), **item}
            for address in _ip_strings(resolved):
                try:
                    result.append(str(ipaddress.ip_address(address)))
                except ValueError:
                    continue
        return list(dict.fromkeys(result))

    private = [record(item) for item in entries(data.get("private_ip", data.get("private_ips")))]
    elastic = [record(item) for item in entries(data.get("elastic_ip", data.get("elastic_ips")))]
    subnets = await catalog("subnets") if private else {}
    private_catalogs = {}
    for item in private:
        subnet = item.get("subnet", item.get("subnet_id"))
        subnet_id = str(subnet.get("id") or "") if isinstance(subnet, dict) else str(subnet or "")
        if subnet_id and subnet_id not in private_catalogs:
            private_catalogs[subnet_id] = await catalog("private-ips", {"subnet_id": subnet_id, "_include_all_private_ips": "true"})
    private_lookup = {key: row for rows in private_catalogs.values() for key, row in rows.items()}
    if any(not (item.get("subnet") or item.get("subnet_id")) for item in private):
        private_lookup.update(await catalog("private-ips", {"_include_all_private_ips": "true"}))
    elastic_lookup = await catalog("elastic-ips") if elastic else {}
    networks = {"private_ips": [], "elastic_ips": []}
    for kind, attached, lookup in [("private_ips", private, private_lookup), ("elastic_ips", elastic, elastic_lookup)]:
        for item in attached:
            source = lookup.get(str(item.get("id") or ""), {})
            if not source and item.get("ip_address"):
                source = next((row for row in lookup.values() if row.get("ip_address") == item["ip_address"]), {})
            source = {**source, **item}
            subnet = source.get("subnet", source.get("subnet_id"))
            subnet_record = subnet if isinstance(subnet, dict) else {"id": str(subnet or "")}
            subnet_record = {**subnets.get(str(subnet_record.get("id") or ""), {}), **subnet_record}
            networks[kind].append({
                "id": source.get("id"),
                "ip_address": source.get("ip_address") or source.get("address") or source.get("ip") or "",
                "subnet": subnet_record if kind == "private_ips" else None,
                "vip_ips": vip_addresses(source.get("allowed_vips") or source.get("vips") or source.get("vip_ip") or [], lookup),
            })
    return networks, list(dict.fromkeys(errors))


@router.get("/servers/{server_id}")
async def server_detail(server_id: str, context: CloudContext, user: UserDep, db: Db, include_network_details: bool = False):
    project, token, approval = context
    data, _ = await cloud_v1.call(
        db,
        user,
        token,
        "GET",
        f"/legacy/api/infra/servers/{server_id}/",
        project,
        approval=approval,
    )
    if data.get("project") != project:
        raise HTTPException(403, "Server does not belong to current project")
    if include_network_details:
        networks, errors = await _server_network_details(data, db, user, token, project, approval)
        data = {**data, "network_details": networks, "network_detail_errors": errors}
    return data


@router.get("/subnets")
async def subnets(context: CloudContext, user: UserDep, db: Db, page: int = 1, page_size: int = 20):
    project, token, approval = context
    data, _ = await cloud_v1.list_resource(
        db,
        user,
        token,
        project,
        "subnets",
        page,
        min(page_size, settings.PAGE_SIZE_MAX),
        approval=approval,
    )
    return page_payload(data, page, page_size)


@router.get("/private-ips")
async def private_ips(
    context: CloudContext,
    user: UserDep,
    db: Db,
    subnet_id: str,
    ip_address: str | None = None,
    available: bool = True,
    include_all: bool = False,
    page: int = 1,
    page_size: int = 20,
):
    project, token, approval = context
    params = {
        "subnet_id": subnet_id,
        **({"_include_all_private_ips": "true"} if include_all else {
            # Keep the upstream query value lowercase (the Cloud API expects
            # `available=true`, not Python's `True`).
            "available": "true" if available else "false"
        }),
        **({"ip_address": ip_address} if ip_address else {}),
    }
    # Use the same shared resource gateway as all other Cloud resources. The
    # adapter enforces the availability flag for private-ips without creating
    # a separate upstream client or transport.
    data, _ = await cloud_v1.list_resource(
        db,
        user,
        token,
        project,
        "private-ips",
        page,
        min(page_size, settings.PAGE_SIZE_MAX),
        params,
        approval,
    )
    return page_payload(data, page, page_size)


@router.get("/elastic-ips")
async def elastic_ips(context: CloudContext, user: UserDep, db: Db, page: int = 1, page_size: int = 200):
    """Project-wide Elastic IP list for read-only Agent workspace snapshots."""
    project, token, approval = context
    data, _ = await cloud_v1.list_resource(
        db, user, token, project, "elastic-ips", page,
        min(page_size, settings.PAGE_SIZE_MAX), approval=approval,
    )
    return page_payload(data, page, page_size)


@router.post("/servers/{server_id}/console")
async def console(server_id: str, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    project, token, approval = context
    detail, _ = await cloud_v1.call(
        db,
        user,
        token,
        "GET",
        f"/legacy/api/infra/servers/{server_id}/",
        project,
        approval=approval,
    )
    if detail.get("project") != project:
        raise HTTPException(403, "Project mismatch")
    data, _ = await cloud_v1.call(
        db,
        user,
        token,
        "POST",
        f"/legacy/api/infra/servers/{server_id}/console/",
        project,
        body={},
        approval=approval,
    )
    url = data.get("url", "")
    parsed = urlsplit(url)
    allowed_schemes = {"https"} if settings.APP_ENV == "production" else {"http", "https"}
    if (
        parsed.scheme not in allowed_schemes
        or parsed.hostname not in settings.CLOUD_API_ALLOWED_HOSTS
    ):
        raise HTTPException(502, "Unsafe console URL returned by Cloud API")
    await write_audit(
        db,
        user,
        "server.console.open",
        "success",
        project_id=project,
        target_type="server",
        target_id=server_id,
    )
    ticket = _issue_console_ticket(_console_websocket_url(url))
    return {
        "url": url,
        "websocket_path": f"/cloud/console-proxy/{ticket}",
    }


@router.websocket("/console-proxy/{ticket}")
async def console_proxy(websocket: WebSocket, ticket: str):
    item = _console_tickets.pop(ticket, None)
    if not item or item[1] <= time.monotonic():
        await websocket.close(code=1008, reason="Console ticket expired")
        return

    upstream_url = item[0]
    parsed = urlsplit(upstream_url)
    origin_scheme = "https" if parsed.scheme == "wss" else "http"
    origin = f"{origin_scheme}://{parsed.netloc}"
    offered_protocols = websocket.headers.get("sec-websocket-protocol", "")
    browser_protocol = "binary" if "binary" in offered_protocols.split(",") else None
    try:
        async with websockets.connect(
            upstream_url,
            origin=origin,
            subprotocols=["binary"],
            compression=None,
            max_size=None,
            proxy=None,
            open_timeout=settings.CLOUD_API_CONNECT_TIMEOUT_SECONDS,
        ) as upstream:
            await websocket.accept(subprotocol=browser_protocol)
            browser_task = asyncio.create_task(_relay_browser_to_vnc(websocket, upstream))
            upstream_task = asyncio.create_task(_relay_vnc_to_browser(websocket, upstream))
            done, pending = await asyncio.wait(
                {browser_task, upstream_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*done, *pending, return_exceptions=True)
    except (
        OSError,
        TimeoutError,
        RuntimeError,
        WebSocketDisconnect,
        websockets.WebSocketException,
    ):
        # Console URLs contain one-time credentials and must never be included
        # in application logs or error responses.
        try:
            await websocket.close(code=1011, reason="VNC gateway connection failed")
        except RuntimeError:
            pass


def _server_sg_ids(values):
    if not isinstance(values, list):
        raise HTTPException(502, "Cloud API did not return a security group list")
    ids = []
    for value in values:
        group_id = value.get("id") if isinstance(value, dict) else value
        if not isinstance(group_id, str) or not group_id:
            raise HTTPException(502, "Cloud API returned an invalid security group")
        ids.append(group_id)
    return sorted(set(ids))


@router.post("/servers/{server_id}/security-groups")
async def update_server_security_groups(
    server_id: str, payload: ServerSecurityGroupsUpdate,
    context: CloudContext, user: Operator, _csrf: Csrf, db: Db,
):
    """One VM per request: no bulk timeout and no automatic write retries."""
    project, token, approval = context
    detail, _ = await cloud_v1.call(
        db, user, token, "GET", f"/legacy/api/infra/servers/{server_id}/",
        project, approval=approval, timeout_seconds=300,
    )
    owner = detail.get("project")
    if isinstance(owner, dict):
        owner = owner.get("id")
    if str(owner or "") != project:
        raise HTTPException(403, "Project mismatch")
    current = _server_sg_ids(detail.get("security_groups"))
    desired = sorted(set(payload.security_groups))
    if current == desired:
        return {"server_id": server_id, "status": "completed", "security_groups": current}
    if current != sorted(set(payload.expected_security_groups)):
        raise HTTPException(409, "Security groups changed elsewhere. Reload this VM before updating.")
    available = await security_groups.all_resource_pages(
        db, user, token, project, "security-groups", approval=approval, timeout_seconds=300,
    )
    valid_ids = {str(group.get("id")) for group in available}
    if set(desired) - valid_ids:
        raise HTTPException(422, "A selected security group does not belong to this project")
    data, code = await cloud_v1.call(
        db, user, token, "POST",
        f"/legacy/api/infra/servers/{server_id}/update-security-group/",
        project, body={"security_groups": desired}, approval=approval,
        timeout_seconds=600,
    )
    await write_audit(
        db, user, "server.security_groups.update", "accepted" if code == 202 else "completed",
        project_id=project, target_type="server", target_id=server_id,
        metadata={"before": current, "after": desired, "upstream_status": code},
    )
    return {"server_id": server_id, "status": "accepted" if code == 202 else "completed", "upstream_status": code, "response": data}


@router.post("/servers/rename")
async def rename_servers(
    payload: RenameBatch, context: CloudContext, user: Operator, _csrf: Csrf, db: Db
):
    project, token, approval = context
    results = []
    for item in payload.items:
        try:
            detail, _ = await cloud_v1.call(
                db,
                user,
                token,
                "GET",
                f"/legacy/api/infra/servers/{item.server_id}/",
                project,
                approval=approval,
            )
            if detail.get("project") != project:
                raise HTTPException(403, "Project mismatch")
            data, _ = await cloud_v1.call(
                db,
                user,
                token,
                "PATCH",
                f"/legacy/api/infra/servers/{item.server_id}/",
                project,
                body={"name": item.new_name},
                approval=approval,
            )
            results.append(
                {"server_id": item.server_id, "status": "completed", "name": data.get("name")}
            )
        except HTTPException as exc:
            results.append(
                {"server_id": item.server_id, "status": "failed", "error": str(exc.detail)}
            )
    await write_audit(
        db,
        user,
        "server.rename.bulk",
        "completed",
        project_id=project,
        metadata={"count": len(results)},
    )
    return {"items": results}


@router.post("/servers/resize")
async def resize_servers(
    payload: ResizeBatch, context: CloudContext, user: Operator, _csrf: Csrf, db: Db
):
    """Submit one resize request per server through the common Cloud gateway.

    Viettel Cloud accepts the resize operation asynchronously (202).  Requests
    are intentionally processed in order so a large Excel import does not
    overload the upstream API; a failure for one row never prevents later rows.
    """
    project, token, approval = context
    results: list[dict[str, Any]] = []
    for item in payload.items:
        server_name: str | None = None
        try:
            detail, _ = await cloud_v1.call(
                db,
                user,
                token,
                "GET",
                f"/legacy/api/infra/servers/{item.server_id}/",
                project,
                approval=approval,
                timeout_seconds=300,
            )
            server_name = detail.get("name")
            detail_project = detail.get("project")
            if isinstance(detail_project, dict):
                detail_project = detail_project.get("id")
            if detail_project != project:
                raise HTTPException(403, "Project mismatch")
            power_state = str(detail.get("power_state") or "").lower()
            if power_state not in {"running", "shutdown", "shutoff", "stopped", "off"}:
                raise HTTPException(422, "VM must be running or shutdown before resizing.")
            if item.live_resize != (power_state == "running"):
                raise HTTPException(409, "VM power state changed. Refresh and review the resize mode.")
            current_specs = detail.get("specs")
            current_specs = current_specs if isinstance(current_specs, dict) else {}
            current_flavor = detail.get("flavor") or current_specs.get("flavor")
            current_flavor = current_flavor if isinstance(current_flavor, dict) else {}
            server_type = next((value for value in (
                current_specs.get("server_type"), current_flavor.get("family"), detail.get("server_type")
            ) if value in ("basic", "gpu")), None)
            if server_type not in {"basic", "gpu"} or server_type != item.specs.server_type:
                raise HTTPException(422, "VM server type could not be verified or does not match.")
            data, status_code = await cloud_v1.call(
                db,
                user,
                token,
                "POST",
                f"/legacy/api/infra/servers/{item.server_id}/resize/",
                project,
                body={"specs": item.specs.model_dump(), "live_resize": item.live_resize},
                approval=approval,
                timeout_seconds=600,
            )
            results.append(
                {
                    "server_id": item.server_id,
                    "name": server_name,
                    "flavor": item.flavor,
                    "flavor_name": item.flavor_name,
                    "specs": item.specs.model_dump(),
                    "live_resize": item.live_resize,
                    "status": "accepted" if status_code == 202 else "completed",
                    "upstream_status": status_code,
                    "response": data,
                }
            )
        except HTTPException as exc:
            results.append(
                {
                    "server_id": item.server_id,
                    "name": server_name,
                    "flavor": item.flavor,
                    "flavor_name": item.flavor_name,
                    "status": "failed",
                    "error": exc.detail,
                }
            )
    succeeded = sum(item["status"] != "failed" for item in results)
    await write_audit(
        db,
        user,
        "server.resize.bulk",
        "completed" if succeeded == len(results) else "partial",
        project_id=project,
        metadata={"requested": len(results), "accepted": succeeded, "failed": len(results) - succeeded},
    )
    return {"items": results}


@router.post("/servers/power")
async def power_servers(
    payload: ServerPowerBatch, context: CloudContext, user: Operator, _csrf: Csrf, db: Db
):
    """Start or stop selected servers through the audited Cloud API gateway.

    Each VM is checked against the active project and submitted independently.
    An upstream failure is returned for that VM only, so later selected VMs
    continue to be processed.
    """
    project, token, approval = context
    # Gateway calls persist their own Cloud API/audit records.  Give each
    # concurrent VM worker its own SQLAlchemy session; sharing the request
    # session across asyncio tasks would make concurrent commits unsafe.
    concurrency = asyncio.Semaphore(3)

    async def process_server(server_id: str) -> dict[str, Any]:
        server_name: str | None = None
        async with concurrency:
            async with SessionFactory() as worker_db:
                try:
                    detail, _ = await cloud_v1.call(
                        worker_db, user, token, "GET", f"/legacy/api/infra/servers/{server_id}/", project,
                        approval=approval,
                    )
                    server_name = detail.get("name")
                    if detail.get("project") != project:
                        raise HTTPException(403, "Project mismatch")
                    data, status_code = await cloud_v1.call(
                        worker_db,
                        user,
                        token,
                        "POST",
                        f"/legacy/api/infra/servers/{server_id}/{payload.action}/",
                        project,
                        body={},
                        approval=approval,
                    )
                    return {
                        "server_id": server_id,
                        "name": server_name,
                        "action": payload.action,
                        "status": "accepted" if status_code == 202 else "completed",
                        "upstream_status": status_code,
                        "response": data,
                    }
                except HTTPException as exc:
                    return {
                        "server_id": server_id,
                        "name": server_name,
                        "action": payload.action,
                        "status": "failed",
                        "upstream_status": exc.status_code,
                        "error": str(exc.detail),
                        "error_detail": exc.detail,
                    }
                except Exception as exc:
                    return {
                        "server_id": server_id,
                        "name": server_name,
                        "action": payload.action,
                        "status": "failed",
                        "error": f"Unexpected gateway error: {exc}",
                    }

    # gather preserves the request order while the semaphore limits active VM
    # operations to three (each worker includes its detail and action call).
    results = await asyncio.gather(*(process_server(server_id) for server_id in payload.server_ids))
    succeeded = sum(item["status"] != "failed" for item in results)
    await write_audit(
        db,
        user,
        f"server.{payload.action}.bulk",
        "completed" if succeeded == len(results) else "partial",
        project_id=project,
        metadata={
            "action": payload.action,
            "requested": len(results),
            "accepted": succeeded,
            "failed": len(results) - succeeded,
            "server_ids": payload.server_ids,
        },
    )
    return {"items": results}


@router.post("/servers/delete")
async def delete_servers(
    payload: ServerDeleteBatch, context: CloudContext, user: Operator, _csrf: Csrf, db: Db
):
    """Delete selected VMs and only their explicitly selected attachments."""
    project, token, approval = context
    concurrency = asyncio.Semaphore(3)

    async def process_server(item) -> dict[str, Any]:
        server_name: str | None = None
        submitted = False
        async with concurrency:
            async with SessionFactory() as worker_db:
                try:
                    detail, _ = await cloud_v1.call(
                        worker_db, user, token, "GET", f"/legacy/api/infra/servers/{item.server_id}/", project,
                        approval=approval, timeout_seconds=300,
                    )
                    server_name = detail.get("name")
                    detail_project = detail.get("project")
                    if isinstance(detail_project, dict):
                        detail_project = detail_project.get("id")
                    if detail_project != project:
                        raise HTTPException(403, "Project mismatch")
                    submitted = True
                    data, status_code = await cloud_v1.call(
                        worker_db, user, token, "POST", f"/legacy/api/infra/servers/{item.server_id}/delete/",
                        project,
                        body={"volumes": item.volumes, "eips": item.eips, "private_ips": item.private_ips},
                        approval=approval, timeout_seconds=600,
                    )
                    return {"server_id": item.server_id, "name": server_name, "status": "accepted" if status_code == 202 else "completed", "upstream_status": status_code, "response": data}
                except HTTPException as exc:
                    return {
                        "server_id": item.server_id,
                        "name": server_name,
                        "status": "unconfirmed" if submitted and exc.status_code >= 500 else "failed",
                        "error": str(exc.detail),
                        "error_detail": exc.detail,
                    }
                except Exception as exc:
                    return {"server_id": item.server_id, "name": server_name, "status": "unconfirmed" if submitted else "failed", "error": f"Unexpected gateway error: {exc}"}

    results = await asyncio.gather(*(process_server(item) for item in payload.items))
    succeeded = sum(item["status"] in {"accepted", "completed"} for item in results)
    await write_audit(
        db, user, "server.delete.bulk", "completed" if succeeded == len(results) else "partial",
        project_id=project,
        metadata={
            "requested": len(results), "accepted": succeeded, "failed": sum(item["status"] == "failed" for item in results), "unconfirmed": sum(item["status"] == "unconfirmed" for item in results),
            "servers": [{"server_id": item.server_id, "volumes": item.volumes, "eips": item.eips, "private_ips": item.private_ips} for item in payload.items],
        },
    )
    return {"items": results}


async def _volume_attachment_server_detail(db, user, token, project, approval, server_id):
    detail, _ = await cloud_v1.call(
        db, user, token, "GET", f"/legacy/api/infra/servers/{server_id}/", project,
        approval=approval,
    )
    if detail.get("project") != project:
        raise HTTPException(403, "Project mismatch")
    return detail


@router.post("/servers/volume-attachments/create")
async def create_attachment_volumes(
    payload: VolumeAttachmentCreate,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Create the requested data volumes for one server, without attaching yet."""
    project, token, approval = context
    detail = await _volume_attachment_server_detail(
        db, user, token, project, approval, payload.server_id
    )
    results: list[dict[str, Any]] = []
    for volume in payload.volumes:
        try:
            data, status_code = await cloud_v1.create_resource(
                db,
                user,
                token,
                project,
                "volumes",
                {
                    "name": volume.name,
                    "description": volume.description,
                    "create_from": {"volume_type": volume.volume_type},
                    "size": volume.size,
                },
                approval,
            )
            item = data[0] if isinstance(data, list) and data else data
            results.append({
                "name": volume.name,
                "volume_id": item.get("id") if isinstance(item, dict) else None,
                "volume_type": volume.volume_type,
                "size": volume.size,
                "status": "created" if status_code in {200, 201, 202} else "submitted",
                "response": item,
            })
        except HTTPException as exc:
            results.append({
                "name": volume.name,
                "volume_type": volume.volume_type,
                "size": volume.size,
                "status": "failed",
                "error": _upstream_error_detail(exc.detail),
                "response": exc.detail,
            })
    await write_audit(
        db, user, "server.volume_attachment.create", "completed",
        project_id=project, target_type="server", target_id=payload.server_id,
        metadata={"server_name": detail.get("name"), "requested": len(payload.volumes), "created": sum(item["status"] != "failed" for item in results)},
    )
    return {"server_id": payload.server_id, "server_name": detail.get("name"), "items": results}


@router.post("/servers/volume-attachments/status")
async def volume_attachment_status(
    payload: VolumeAttachmentStatus,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Read the current status for a small set of newly-created volumes."""
    project, token, approval = context
    results: list[dict[str, Any]] = []
    for volume_id in payload.volume_ids:
        try:
            data, _ = await cloud_v1.call(
                db, user, token, "GET", f"/legacy/api/infra/volumes/{volume_id}/", project,
                approval=approval,
            )
            if data.get("project") != project:
                raise HTTPException(403, "Project mismatch")
            results.append({
                "volume_id": volume_id,
                "name": data.get("name"),
                "status": str(data.get("status") or "unknown").lower(),
                "size": data.get("size"),
                "volume_type": (data.get("create_from") or {}).get("volume_type") if isinstance(data.get("create_from"), dict) else None,
            })
        except HTTPException as exc:
            results.append({"volume_id": volume_id, "status": "failed", "error": _upstream_error_detail(exc.detail), "response": exc.detail})
    return {"items": results}


@router.post("/servers/volume-attachments/attach")
async def attach_created_volumes(
    payload: VolumeAttachmentAttach,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Attach only volumes confirmed as available; each attachment is isolated."""
    project, token, approval = context
    detail = await _volume_attachment_server_detail(
        db, user, token, project, approval, payload.server_id
    )
    results: list[dict[str, Any]] = []
    for volume_id in payload.volume_ids:
        try:
            volume, _ = await cloud_v1.call(
                db, user, token, "GET", f"/legacy/api/infra/volumes/{volume_id}/", project,
                approval=approval,
            )
            if volume.get("project") != project:
                raise HTTPException(403, "Project mismatch")
            if str(volume.get("status") or "").lower() != "available":
                raise HTTPException(409, f"Volume is not available (status: {volume.get('status') or 'unknown'})")
            for attempt in range(2):
                try:
                    data, status_code = await cloud_v1.call(
                        db, user, token, "POST",
                        f"/legacy/api/infra/servers/{payload.server_id}/attach-volume/", project,
                        body={"volume": volume_id}, approval=approval,
                    )
                    break
                except HTTPException as exc:
                    pending = "can not perform requested action when server status is pending" in _upstream_error_detail(exc.detail).lower()
                    if pending and attempt == 0:
                        await asyncio.sleep(5)
                        continue
                    raise
            results.append({
                "volume_id": volume_id,
                "name": volume.get("name"),
                "status": "attached" if status_code in {200, 201, 202} else "submitted",
                "response": data,
            })
        except HTTPException as exc:
            results.append({"volume_id": volume_id, "status": "failed", "error": _upstream_error_detail(exc.detail), "response": exc.detail})
    await write_audit(
        db, user, "server.volume_attachment.attach", "completed",
        project_id=project, target_type="server", target_id=payload.server_id,
        metadata={"server_name": detail.get("name"), "requested": len(payload.volume_ids), "attached": sum(item["status"] != "failed" for item in results)},
    )
    return {"server_id": payload.server_id, "server_name": detail.get("name"), "items": results}


@router.post("/servers/volume-attachments/detach")
async def detach_server_volumes(
    payload: VolumeAttachmentDetach,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Detach selected volumes from one server, isolating every upstream call."""
    project, token, approval = context
    detail = await _volume_attachment_server_detail(
        db, user, token, project, approval, payload.server_id
    )
    results: list[dict[str, Any]] = []
    for volume_id in payload.volume_ids:
        try:
            data, status_code = await cloud_v1.call(
                db,
                user,
                token,
                "POST",
                f"/legacy/api/infra/servers/{payload.server_id}/detach-volume/",
                project,
                body={"volume": volume_id},
                approval=approval,
            )
            results.append({
                "volume_id": volume_id,
                "status": "detached" if status_code in {200, 201, 202, 204} else "submitted",
                "response": data,
            })
        except HTTPException as exc:
            results.append({"volume_id": volume_id, "status": "failed", "error": str(exc.detail)})
    detached = sum(item["status"] != "failed" for item in results)
    await write_audit(
        db,
        user,
        "server.volume_attachment.detach",
        "completed" if detached == len(results) else "partial",
        project_id=project,
        target_type="server",
        target_id=payload.server_id,
        metadata={"server_name": detail.get("name"), "requested": len(payload.volume_ids), "detached": detached},
    )
    return {"server_id": payload.server_id, "server_name": detail.get("name"), "items": results}


@router.post("/servers/change-password")
async def change_password(
    payload: PasswordBatch, context: CloudContext, user: Operator, _csrf: Csrf, db: Db
):
    project, token, approval = context
    profile = await db.get(PasswordProfile, payload.profile_id) if payload.profile_id else None
    if payload.profile_id and (not profile or not profile.is_active):
        raise HTTPException(404, "Password profile not found")
    shared_password = decrypt_profile(profile) if profile else payload.password
    if not shared_password and not payload.password_items:
        raise HTTPException(422, "Password is required")
    results = []
    password_targets = (
        [(item.server_id, item.password) for item in payload.password_items]
        if payload.password_items
        else [(server_id, shared_password or "") for server_id in payload.server_ids]
    )
    for server_id, target_password in password_targets:
        try:
            _, code = await cloud_v1.call(
                db,
                user,
                token,
                "POST",
                f"/legacy/api/infra/servers/{server_id}/change-password/",
                project,
                body={"new_password": target_password},
                approval=approval,
            )
            results.append(
                {"server_id": server_id, "status": "accepted" if code == 202 else "completed"}
            )
        except HTTPException as exc:
            results.append({"server_id": server_id, "status": "failed", "error": str(exc.detail), "error_detail": exc.detail})
    shared_password = ""
    password_targets.clear()
    await write_audit(
        db,
        user,
        "server.password.bulk",
        "accepted",
        project_id=project,
        metadata={
            "count": len(results),
            "password_source": "profile" if profile else "per_server" if payload.password_items else "custom",
            **({"profile_id": profile.id} if profile else {}),
        },
    )
    return {"items": results}


def build_ip_range(payload: IpRangeIn) -> list[ipaddress._BaseAddress]:
    start = ipaddress.ip_address(payload.start_ip)
    if payload.end_ip:
        end = ipaddress.ip_address(payload.end_ip)
        if start.version != end.version or int(end) < int(start):
            raise HTTPException(422, "Invalid IP range")
        count = int(end) - int(start) + 1
    elif payload.count:
        count = payload.count
    else:
        raise HTTPException(422, "Provide end_ip or count")
    if count > 1000:
        raise HTTPException(422, "IP range exceeds batch limit")
    try:
        return [ipaddress.ip_address(int(start) + offset) for offset in range(count)]
    except ValueError:
        raise HTTPException(422, "IP range overflows address space") from None


@router.post("/private-ips/create-range")
async def create_ip_range(
    payload: IpRangeIn, context: CloudContext, user: Operator, _csrf: Csrf, db: Db
):
    project, token, approval = context
    subnet_data, _ = await cloud_v1.call(
        db,
        user,
        token,
        "GET",
        "/legacy/api/infra/subnets/",
        project,
        params={"page": 1, "page_size": 200},
        approval=approval,
    )
    subnet = next(
        (x for x in subnet_data.get("results", []) if x.get("id") == payload.subnet_id), None
    )
    if not subnet:
        await write_audit(
            db,
            user,
            "private_ip.create_range",
            "failed",
            project_id=project,
            metadata={
                "subnet_id": payload.subnet_id,
                "reason": "subnet_not_found",
            },
        )
        raise HTTPException(404, "Subnet was not found")
    # Shared subnets remain selectable. The request always retains the active
    # project-id supplied by the current CloudTool context.
    network = ipaddress.ip_network(subnet["cidr"], strict=False)
    requested = build_ip_range(payload)
    if any(
        ip not in network
        or (network.version == 4 and ip in {network.network_address, network.broadcast_address})
        for ip in requested
    ):
        raise HTTPException(422, "Range includes address outside usable subnet space")
    results, tried = [], {str(ip) for ip in requested}

    async def create_one(ip):
        try:
            data, _ = await cloud_v1.call(
                db,
                user,
                token,
                "POST",
                "/legacy/api/infra/private-ips/",
                project,
                body={"ip_address": str(ip), "description": "", "subnet": payload.subnet_id},
                approval=approval,
            )
            business_ok = data.get("description") == "" and data.get("server") is None
            result = {
                "ip_address": str(ip),
                "ip_id": data.get("id"),
                "status": "completed" if business_ok else "business_failed",
                "data": data,
            }
            if data.get("id"):
                db.add(
                    ResourceMarker(
                        project_id=project,
                        resource_type="private_ip",
                        resource_id=data["id"],
                        actor_id=user.id,
                        marked_at=db_now(),
                        result=result["status"],
                    )
                )
            return result
        except HTTPException as exc:
            return {"ip_address": str(ip), "status": "failed", "error": str(exc.detail)}

    for ip in requested:
        results.append(await create_one(ip))
    if payload.compensate:
        failures = sum(x["status"] != "completed" for x in results)
        candidate = requested[-1]
        while failures and len(tried) < 2000:
            candidate = ipaddress.ip_address(int(candidate) + 1)
            if candidate not in network or (
                network.version == 4 and candidate == network.broadcast_address
            ):
                break
            if str(candidate) in tried:
                continue
            tried.add(str(candidate))
            result = await create_one(candidate)
            results.append(result)
            failures -= result["status"] == "completed"
    await db.commit()
    await write_audit(
        db,
        user,
        "private_ip.create_range",
        "completed",
        project_id=project,
        metadata={
            "subnet_id": payload.subnet_id,
            "requested": len(requested),
            "results": len(results),
        },
    )
    return {"items": results}


@router.post("/private-ips/create-ordered")
async def create_ordered_private_ips(
    payload: OrderedPrivateIpCreate,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Create one available address per draft, sequentially from each subnet start."""
    project, token, approval = context
    subnets, page = {}, 1
    while True:
        data, _ = await cloud_v1.call(
            db, user, token, "GET", "/legacy/api/infra/subnets/", project,
            params={"page": page, "page_size": 200}, approval=approval,
        )
        rows = data.get("results", [])
        subnets.update({str(row.get("id")): row for row in rows if row.get("id")})
        if not data.get("next"):
            break
        page += 1

    grouped: dict[str, list] = {}
    for item in payload.items:
        grouped.setdefault(item.subnet_id, []).append(item)
    results_by_draft: dict[str, dict] = {}
    remaining_retries = (
        payload.max_retries
        if payload.max_retries is not None
        else (len(payload.items) + 2) // 3
    )

    for subnet_id, targets in grouped.items():
        subnet = subnets.get(subnet_id)
        if not subnet or not subnet.get("cidr"):
            for target in targets:
                results_by_draft[target.server_draft_id] = {
                    "server_draft_id": target.server_draft_id,
                    "server_name": target.server_name,
                    "subnet_id": subnet_id,
                    "status": "failed",
                    "error": "Subnet was not found in the active project",
                }
            continue
        network = ipaddress.ip_network(str(subnet["cidr"]), strict=False)
        # Get all allocated/reserved addresses once per subnet. The internal
        # marker is removed by the common gateway and never reaches Cloud API.
        all_existing, occupied, available_ips, ip_page = set(), set(), {}, 1
        while True:
            data, _ = await cloud_v1.call(
                db, user, token, "GET", "/legacy/api/infra/private-ips/", project,
                params={"page": ip_page, "page_size": 1000, "subnet_id": subnet_id,
                        "_include_all_private_ips": "true"}, approval=approval,
            )
            for row in data.get("results", []):
                address = str(row.get("ip_address") or "")
                if not address:
                    continue
                all_existing.add(address)
                if row.get("server") is None and row.get("description") in (None, "") and row.get("id"):
                    available_ips[address] = row
                else:
                    occupied.add(address)
            if not data.get("next"):
                break
            ip_page += 1

        # .1 is conventionally the subnet gateway in this environment; begin
        # after it, then move strictly upward so allocation is deterministic.
        candidate = int(network.network_address) + (2 if network.version == 4 else 1)
        last = int(network.broadcast_address) - (1 if network.version == 4 else 0)
        async def create_address(address: str) -> tuple[dict | None, str | None]:
            try:
                created, _ = await cloud_v1.call(
                    db, user, token, "POST", "/legacy/api/infra/private-ips/", project,
                    body={"ip_address": address, "description": "", "subnet": subnet_id}, approval=approval,
                )
                if created.get("id") and created.get("description") == "" and created.get("server") is None:
                    return created, None
                return None, "Cloud API did not return an available private IP"
            except HTTPException as exc:
                return None, str(exc.detail)

        exhausted = False
        for target in targets:
            if exhausted:
                results_by_draft[target.server_draft_id] = {
                    "server_draft_id": target.server_draft_id, "server_name": target.server_name,
                    "subnet_id": subnet_id, "status": "failed", "error": "Subnet capacity exhausted; allocation stopped",
                }
                continue
            last_error, address = "", ""
            while True:
                unavailable = occupied if payload.reuse_available else all_existing
                while candidate <= last and str(ipaddress.ip_address(candidate)) in unavailable:
                    candidate += 1
                if candidate > last:
                    exhausted = True
                    break
                address = str(ipaddress.ip_address(candidate))
                candidate += 1
                reusable = available_ips.get(address) if payload.reuse_available else None
                if reusable:
                    results_by_draft[target.server_draft_id] = {
                        "server_draft_id": target.server_draft_id, "server_name": target.server_name,
                        "subnet_id": subnet_id, "ip_address": address, "ip_id": reusable["id"], "status": "reused",
                    }
                    occupied.add(address)
                    all_existing.add(address)
                    break
                # Retry the same address once before consuming a new-IP retry.
                created, last_error = await create_address(address)
                if not created:
                    created, last_error = await create_address(address)
                if created:
                    db.add(ResourceMarker(project_id=project, resource_type="private_ip", resource_id=created["id"], actor_id=user.id, marked_at=db_now(), result="completed"))
                    occupied.add(address)
                    all_existing.add(address)
                    results_by_draft[target.server_draft_id] = {
                        "server_draft_id": target.server_draft_id, "server_name": target.server_name,
                        "subnet_id": subnet_id, "ip_address": address, "ip_id": created["id"], "status": "completed",
                    }
                    break
                # Do not reuse a failed address: the first request may have
                # reached Cloud API despite an invalid/empty response.
                occupied.add(address)
                all_existing.add(address)
                if remaining_retries <= 0:
                    results_by_draft[target.server_draft_id] = {
                        "server_draft_id": target.server_draft_id, "server_name": target.server_name,
                        "subnet_id": subnet_id, "ip_address": address, "status": "failed",
                        "error": f"{last_error}; new-IP retry limit reached",
                    }
                    break
                remaining_retries -= 1
            if exhausted:
                results_by_draft[target.server_draft_id] = {
                    "server_draft_id": target.server_draft_id, "server_name": target.server_name,
                    "subnet_id": subnet_id, "status": "failed", "error": "No free address remains in this subnet",
                }
    results = [results_by_draft[item.server_draft_id] for item in payload.items]
    await db.commit()
    await write_audit(db, user, "private_ip.create_ordered", "completed", project_id=project,
                      metadata={"requested": len(payload.items), "succeeded": sum(x["status"] in {"completed", "reused"} for x in results)})
    return {"items": results}


@router.post("/private-ips/delete")
async def delete_private_ips(
    payload: PrivateIpDeleteBatch,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Delete only unreserved, unattached private IPs through the shared Cloud gateway."""
    project, token, approval = context
    inventory: dict[str, dict[str, Any]] = {}
    page = 1
    while True:
        data, _ = await cloud_v1.list_resource(
            db,
            user,
            token,
            project,
            "private-ips",
            page,
            settings.PAGE_SIZE_MAX,
            params={
                "subnet_id": payload.subnet_id,
                "_include_all_private_ips": "true",
            },
            approval=approval,
        )
        rows = data.get("results", [])
        inventory.update({row.get("id"): row for row in rows if row.get("id")})
        if not data.get("next"):
            break
        page += 1

    results = []
    for ip_id in payload.ip_ids:
        ip = inventory.get(ip_id)
        result = {"ip_id": ip_id, "ip_address": ip.get("ip_address") if ip else None}
        if not ip:
            results.append({**result, "status": "failed", "error": "Private IP was not found in the selected subnet."})
            continue
        if ip.get("server") is not None or ip.get("description") not in (None, ""):
            results.append({**result, "status": "skipped", "error": "Only available private IPs can be deleted."})
            continue
        try:
            _, code = await cloud_v1.call(
                db,
                user,
                token,
                "DELETE",
                f"/legacy/api/infra/private-ips/{ip_id}/",
                project,
                approval=approval,
            )
            results.append(
                {
                    **result,
                    "status": "completed" if code == 204 else "accepted",
                    "http_status": code,
                }
            )
        except HTTPException as exc:
            results.append({**result, "status": "failed", "error": str(exc.detail)})

    await write_audit(
        db,
        user,
        "private_ip.delete_batch",
        "completed" if any(item["status"] in {"completed", "accepted"} for item in results) else "failed",
        project_id=project,
        metadata={
            "subnet_id": payload.subnet_id,
            "requested": len(payload.ip_ids),
            "completed": sum(item["status"] in {"completed", "accepted"} for item in results),
        },
    )
    return {"items": results}


@router.post("/servers/attach-private-ips")
async def attach_private_ips(
    payload: AttachBatch, context: CloudContext, user: Operator, _csrf: Csrf, db: Db
):
    project, token, approval = context
    zones = {
        x["id"]: x.get("region", {}).get("name")
        for x in await get_zones(db, user, token, project, approval)
    }
    ip_data, _ = await cloud_v1.call(
        db,
        user,
        token,
        "GET",
        "/legacy/api/infra/private-ips/",
        project,
        params={"page": 1, "page_size": 1000},
        approval=approval,
    )
    ips = {x["id"]: x for x in ip_data.get("results", [])}
    results = []
    for item in payload.items:
        try:
            server, _ = await cloud_v1.call(
                db,
                user,
                token,
                "GET",
                f"/legacy/api/infra/servers/{item.server_id}/",
                project,
                approval=approval,
            )
            ip = ips.get(item.ip_id)
            if server.get("project") != project or not ip or ip.get("project") != project:
                raise HTTPException(403, "Resource project mismatch")
            if ip.get("server") is not None or ip.get("description") != "":
                raise HTTPException(409, "Private IP is not available")
            if zones.get(server.get("zone")) != ip.get("region"):
                raise HTTPException(409, "Server zone and IP region do not match")
            _, code = await cloud_v1.call(
                db,
                user,
                token,
                "POST",
                f"/legacy/api/infra/servers/{item.server_id}/attach-privateip/",
                project,
                body={"privateip": item.ip_id},
                approval=approval,
            )
            status_value = "accepted" if code == 202 else "completed"
            results.append(
                {
                    "server_id": item.server_id,
                    "ip_id": item.ip_id,
                    "status": status_value,
                    "request": {
                        "method": "POST",
                        "path": f"/legacy/api/infra/servers/{item.server_id}/attach-privateip/",
                        "body": {"privateip": item.ip_id},
                    },
                }
            )
            db.add(
                ResourceMarker(
                    project_id=project,
                    resource_type="server",
                    resource_id=item.server_id,
                    actor_id=user.id,
                    marked_at=db_now(),
                    result=status_value,
                )
            )
        except HTTPException as exc:
            results.append(
                {
                    "server_id": item.server_id,
                    "ip_id": item.ip_id,
                    "status": "failed",
                    "error": _upstream_error_detail(exc.detail),
                    "response": exc.detail,
                    "request": {
                        "method": "POST",
                        "path": f"/legacy/api/infra/servers/{item.server_id}/attach-privateip/",
                        "body": {"privateip": item.ip_id},
                    },
                }
            )
    await db.commit()
    await write_audit(
        db,
        user,
        "server.attach_private_ip.bulk",
        "completed",
        project_id=project,
        metadata={"count": len(results)},
    )
    return {"items": results}


@router.post("/servers/detach-private-ips")
async def detach_private_ips(
    payload: DetachPrivateIpBatch,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Detach selected private addresses sequentially with per-row outcomes.

    A sequential upstream workflow deliberately keeps large bulk operations from
    overloading the cloud console and makes one failed address independent from
    every remaining address.
    """
    project, token, approval = context
    results = []
    for item in payload.items:
        result = {"server_id": item.server_id, "ip_id": item.ip_id}
        try:
            server, _ = await cloud_v1.call(
                db,
                user,
                token,
                "GET",
                f"/legacy/api/infra/servers/{item.server_id}/",
                project,
                approval=approval,
            )
            private_ips = server.get("private_ip") or server.get("private_ips") or []
            attached_ids = {
                str(address.get("id"))
                for address in private_ips
                if isinstance(address, dict) and address.get("id")
            }
            if server.get("project") != project:
                raise HTTPException(403, "Server project mismatch")
            if item.ip_id not in attached_ids:
                raise HTTPException(409, "Private IP is not attached to this server")
            _, code = await cloud_v1.call(
                db,
                user,
                token,
                "POST",
                f"/legacy/api/infra/servers/{item.server_id}/detach-private-ip/",
                project,
                body={"privateip": item.ip_id},
                approval=approval,
            )
            results.append(
                {
                    **result,
                    "status": "completed" if code in {200, 202, 204} else "accepted",
                    "http_status": code,
                    "request": {
                        "method": "POST",
                        "path": f"/legacy/api/infra/servers/{item.server_id}/detach-private-ip/",
                        "body": {"privateip": item.ip_id},
                    },
                }
            )
        except HTTPException as exc:
            results.append(
                {
                    **result,
                    "status": "failed",
                    "error": _upstream_error_detail(exc.detail),
                    "response": exc.detail,
                    "request": {
                        "method": "POST",
                        "path": f"/legacy/api/infra/servers/{item.server_id}/detach-private-ip/",
                        "body": {"privateip": item.ip_id},
                    },
                }
            )

    await write_audit(
        db,
        user,
        "server.detach_private_ip.bulk",
        "completed" if any(row["status"] != "failed" for row in results) else "failed",
        project_id=project,
        metadata={
            "requested": len(payload.items),
            "completed": sum(row["status"] != "failed" for row in results),
        },
    )
    return {"items": results}


async def _project_elastic_ips(db, user, token, project, approval):
    """Read all elastic IPs once for a batch, through the standard gateway."""
    items: dict[str, dict[str, Any]] = {}
    page = 1
    while True:
        data, _ = await cloud_v1.call(
            db,
            user,
            token,
            "GET",
            "/legacy/api/infra/elastic-ips/",
            project,
            params={"page": page, "page_size": 200},
            approval=approval,
        )
        rows = data.get("results", []) if isinstance(data, dict) else []
        for row in rows:
            if isinstance(row, dict) and row.get("id"):
                items[str(row["id"])] = row
        if not data.get("next") or not rows:
            return items
        page += 1


@router.post("/servers/attach-elastic-ips")
async def attach_elastic_ips(
    payload: AttachElasticIpBatch,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Attach available elastic IPs sequentially, with independent results."""
    project, token, approval = context
    elastic_ips = await _project_elastic_ips(db, user, token, project, approval)
    results = []
    for item in payload.items:
        request = {
            "method": "POST",
            "path": f"/legacy/api/infra/servers/{item.server_id}/attach-eip/",
            "body": {"eip": item.ip_id},
        }
        try:
            server, _ = await cloud_v1.call(
                db, user, token, "GET", f"/legacy/api/infra/servers/{item.server_id}/",
                project, approval=approval,
            )
            elastic_ip = elastic_ips.get(item.ip_id)
            if server.get("project") != project or not elastic_ip or elastic_ip.get("project") != project:
                raise HTTPException(403, "Resource project mismatch")
            if elastic_ip.get("server") is not None:
                raise HTTPException(409, "Elastic IP is not available")
            response, code = await cloud_v1.call(
                db, user, token, "POST", request["path"], project,
                body=request["body"], approval=approval,
            )
            results.append({
                "server_id": item.server_id, "ip_id": item.ip_id,
                "status": "completed" if code in {200, 201, 202, 204} else "accepted",
                "http_status": code, "request": request, "response": response,
            })
        except HTTPException as exc:
            results.append({
                "server_id": item.server_id, "ip_id": item.ip_id, "status": "failed",
                "error": _upstream_error_detail(exc.detail), "response": exc.detail,
                "request": request,
            })
    await write_audit(
        db, user, "server.attach_elastic_ip.bulk",
        "completed" if any(row["status"] != "failed" for row in results) else "failed",
        project_id=project,
        metadata={"requested": len(payload.items), "completed": sum(row["status"] != "failed" for row in results)},
    )
    return {"items": results}


@router.post("/servers/detach-elastic-ips")
async def detach_elastic_ips(
    payload: DetachElasticIpBatch,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
    db: Db,
):
    """Detach selected elastic IPs sequentially, preserving per-IP evidence."""
    project, token, approval = context
    results = []
    for item in payload.items:
        request = {
            "method": "POST",
            "path": f"/legacy/api/infra/servers/{item.server_id}/detach-eip/",
            "body": {"eip": item.ip_id},
        }
        try:
            server, _ = await cloud_v1.call(
                db, user, token, "GET", f"/legacy/api/infra/servers/{item.server_id}/",
                project, approval=approval,
            )
            attached_ids = {
                str(address.get("id"))
                for address in (server.get("elastic_ip") or server.get("elastic_ips") or [])
                if isinstance(address, dict) and address.get("id")
            }
            if server.get("project") != project:
                raise HTTPException(403, "Server project mismatch")
            if item.ip_id not in attached_ids:
                raise HTTPException(409, "Elastic IP is not attached to this server")
            response, code = await cloud_v1.call(
                db, user, token, "POST", request["path"], project,
                body=request["body"], approval=approval,
            )
            results.append({
                "server_id": item.server_id, "ip_id": item.ip_id,
                "status": "completed" if code in {200, 201, 202, 204} else "accepted",
                "http_status": code, "request": request, "response": response,
            })
        except HTTPException as exc:
            results.append({
                "server_id": item.server_id, "ip_id": item.ip_id, "status": "failed",
                "error": _upstream_error_detail(exc.detail), "response": exc.detail,
                "request": request,
            })
    await write_audit(
        db, user, "server.detach_elastic_ip.bulk",
        "completed" if any(row["status"] != "failed" for row in results) else "failed",
        project_id=project,
        metadata={"requested": len(payload.items), "completed": sum(row["status"] != "failed" for row in results)},
    )
    return {"items": results}


def export_value(value):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return "'" + text if text.startswith(("=", "+", "-", "@")) else text


@router.get("/exports/servers")
async def export_servers(
    context: CloudContext,
    user: UserDep,
    db: Db,
    format: str = "csv",
    mode: str = "simple",
):
    if format not in {"csv", "xlsx"} or mode not in {"simple", "full"}:
        raise HTTPException(422, "format or mode is invalid")
    project, token, approval = context
    rows, page, total = [], 1, None
    while total is None or len(rows) < total:
        data, _ = await cloud_v1.list_resource(
            db, user, token, project, "servers", page, 200, approval=approval
        )
        total = min(int(data.get("count", 0)), settings.EXPORT_MAX_ROWS)
        rows.extend(data.get("results", []))
        if not data.get("results") or len(rows) >= total:
            break
        page += 1
    zones = {
        item["id"]: item.get("display_name", item.get("name"))
        for item in await get_zones(db, user, token, project, approval)
    }
    simple_fields = ["id", "name", "elastic_ip", "private_ip", "server_type", "zone", "bandwidth"]
    safe_rows = []
    for item in rows[: settings.EXPORT_MAX_ROWS]:
        normalized = dict(item) if mode == "full" else {key: item.get(key) for key in simple_fields}
        normalized["zone"] = zones.get(item.get("zone"), item.get("zone"))
        for field in ("elastic_ip", "private_ip"):
            normalized[field] = [
                {"id": ip.get("id"), "ip_address": ip.get("ip_address")}
                for ip in item.get(field, [])
            ]
        safe_rows.append(normalized)
    fields = (
        sorted({key for item in safe_rows for key in item}) if mode == "full" else simple_fields
    )
    filename = f"servers-{project}-{mode}.{format}"
    if format == "csv":
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(
            {key: export_value(item.get(key, "")) for key in fields} for item in safe_rows
        )
        return StreamingResponse(
            iter(["\ufeff" + output.getvalue()]),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    workbook = Workbook(write_only=True)
    sheet = workbook.create_sheet("servers")
    sheet.append(fields)
    for item in safe_rows:
        sheet.append([export_value(item.get(key, "")) for key in fields])
    binary = io.BytesIO()
    workbook.save(binary)
    binary.seek(0)
    return StreamingResponse(
        binary,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
