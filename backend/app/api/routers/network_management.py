import asyncio
import ipaddress
from typing import Any

from fastapi import APIRouter, HTTPException

from app.api.deps import CloudContext, Csrf, Db, Operator, UserDep
from app.core.config import get_settings
from app.gateway import cloud_v1
from app.schemas.network import (
    NetworkDeleteBatch,
    NetworkImportIn,
    NetworkResourceCreate,
    NetworkResourceUpdate,
    VpcInternetAccessIn,
)
from app.services.audit import write_audit

router = APIRouter(prefix="/network", tags=["Network management"])

RESOURCE_PATHS = {
    "vpc": "vpcs",
    "subnet": "subnets",
    "security_group": "security-groups",
}


def _page(data: dict[str, Any], page: int, page_size: int) -> dict[str, Any]:
    return {
        "items": data.get("results", []),
        "total": data.get("count", 0),
        "page": page,
        "page_size": page_size,
    }


def _validate_create(kind: str, payload: NetworkResourceCreate) -> dict[str, Any]:
    body = {"name": payload.name, "description": payload.description}
    if kind in {"vpc", "subnet"}:
        if not payload.cidr:
            raise HTTPException(422, "CIDR is required")
        try:
            body["cidr"] = str(ipaddress.ip_network(payload.cidr, strict=True))
        except ValueError as exc:
            raise HTTPException(422, f"Invalid CIDR: {exc}") from None
    if kind in {"vpc", "security_group"}:
        if not payload.region:
            raise HTTPException(422, "Region is required")
        body["region"] = payload.region
    if kind == "subnet":
        if not payload.vpc:
            raise HTTPException(422, "VPC is required")
        body["vpc"] = payload.vpc
    return body


async def _region_lookup(
    context: CloudContext,
    user: UserDep,
    db: Db,
) -> dict[str, str]:
    """Load region names through the existing zones API and map them to IDs."""
    project, token, approval = context
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
    lookup: dict[str, str] = {}
    for zone in data.get("results", []):
        region = zone.get("region")
        if not isinstance(region, dict):
            continue
        region_id = str(region.get("id") or "")
        for value in (
            region_id,
            str(region.get("name") or ""),
            str(region.get("display_name") or ""),
        ):
            if value:
                lookup[value.casefold()] = region_id
    return lookup


async def _resolve_region_id(
    region_name: str,
    context: CloudContext,
    user: UserDep,
    db: Db,
    lookup: dict[str, str] | None = None,
) -> str:
    """Resolve a human-readable region name without exposing its ID to the UI."""
    region_id = (lookup or await _region_lookup(context, user, db)).get(
        region_name.strip().casefold()
    )
    if region_id:
        return region_id
    raise HTTPException(422, f"Region '{region_name}' was not found")


async def _audit(
    db: Db,
    user: Operator,
    action: str,
    result: str,
    project: str,
    kind: str,
    target_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    await write_audit(
        db,
        user,
        action,
        result,
        project_id=project,
        target_type=kind,
        target_id=target_id,
        metadata=metadata,
    )


async def _list_resource(
    kind: str, context: CloudContext, user: UserDep, db: Db, page: int, page_size: int
) -> dict[str, Any]:
    project, token, approval = context
    data, _ = await cloud_v1.list_resource(
        db,
        user,
        token,
        project,
        RESOURCE_PATHS[kind],
        page,
        min(page_size, 200),
        approval=approval,
    )
    return _page(data, page, page_size)


async def _all_resources(
    kind: str, context: CloudContext, user: UserDep, db: Db
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    page = 1
    while True:
        response = await _list_resource(kind, context, user, db, page, 200)
        items = response["items"]
        rows.extend(items)
        if not items or len(rows) >= response["total"]:
            return rows
        page += 1


async def _create_resource(
    kind: str,
    payload: NetworkResourceCreate,
    context: CloudContext,
    user: Operator,
    db: Db,
    region_lookup: dict[str, str] | None = None,
    request_capture: dict[str, Any] | None = None,
) -> Any:
    project, token, approval = context
    body = _validate_create(kind, payload)
    if kind in {"vpc", "security_group"}:
        body["region"] = await _resolve_region_id(
            str(body["region"]), context, user, db, region_lookup
        )
    # Import results may expose the safe request body back to the operator.  It
    # never contains the Cloud token or any gateway headers.
    if request_capture is not None:
        request_capture.update(body)
    try:
        data, _ = await cloud_v1.create_resource(
            db, user, token, project, RESOURCE_PATHS[kind], body, approval
        )
    except HTTPException:
        await _audit(db, user, f"network.{kind}.create", "failed", project, kind, metadata={"name": payload.name})
        raise
    target_id = str(data.get("id") or "") if isinstance(data, dict) else None
    await _audit(db, user, f"network.{kind}.create", "success", project, kind, target_id, {"name": payload.name})
    return data


async def _update_resource(
    kind: str,
    resource_id: str,
    payload: NetworkResourceUpdate,
    context: CloudContext,
    user: Operator,
    db: Db,
) -> Any:
    project, token, approval = context
    body = payload.model_dump()
    try:
        data, _ = await cloud_v1.call(
            db,
            user,
            token,
            "PUT",
            f"/legacy/api/infra/{RESOURCE_PATHS[kind]}/{resource_id}/",
            project,
            body=body,
            approval=approval,
        )
    except HTTPException:
        await _audit(db, user, f"network.{kind}.update", "failed", project, kind, resource_id, {"name": payload.name})
        raise
    await _audit(db, user, f"network.{kind}.update", "success", project, kind, resource_id, {"name": payload.name})
    return data


async def _delete_one(
    kind: str,
    resource_id: str,
    context: CloudContext,
    user: Operator,
    db: Db,
) -> Any:
    project, token, approval = context
    try:
        data, _ = await cloud_v1.call(
            db,
            user,
            token,
            "DELETE",
            f"/legacy/api/infra/{RESOURCE_PATHS[kind]}/{resource_id}/",
            project,
            approval=approval,
        )
    except HTTPException:
        await _audit(db, user, f"network.{kind}.delete", "failed", project, kind, resource_id)
        raise
    await _audit(db, user, f"network.{kind}.delete", "success", project, kind, resource_id)
    return data


async def _delete_batch(
    kind: str,
    payload: NetworkDeleteBatch,
    context: CloudContext,
    user: Operator,
    db: Db,
) -> dict[str, Any]:
    results = []
    for resource_id in dict.fromkeys(payload.ids):
        try:
            await _delete_one(kind, resource_id, context, user, db)
            results.append({"id": resource_id, "status": "deleted"})
        except HTTPException as exc:
            results.append({"id": resource_id, "status": "failed", "error": exc.detail})
    return {
        "items": results,
        "deleted": sum(item["status"] == "deleted" for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
    }


@router.get("/vpcs")
async def vpcs(context: CloudContext, user: UserDep, db: Db, page: int = 1, page_size: int = 200):
    return await _list_resource("vpc", context, user, db, page, page_size)


@router.post("/vpcs")
async def create_vpc(payload: NetworkResourceCreate, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    return await _create_resource("vpc", payload, context, user, db)


@router.put("/vpcs/{resource_id}")
async def update_vpc(resource_id: str, payload: NetworkResourceUpdate, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    return await _update_resource("vpc", resource_id, payload, context, user, db)


@router.delete("/vpcs/{resource_id}")
async def delete_vpc(resource_id: str, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    return await _delete_one("vpc", resource_id, context, user, db)


@router.post("/vpcs/delete")
async def delete_vpcs(payload: NetworkDeleteBatch, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    return await _delete_batch("vpc", payload, context, user, db)


@router.put("/vpcs/{resource_id}/internet-access")
async def set_vpc_internet_access(resource_id: str, payload: VpcInternetAccessIn, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    project, token, approval = context
    route_table_id = payload.route_table_id
    if not route_table_id:
        vpcs_page = await _all_resources("vpc", context, user, db)
        selected = next((row for row in vpcs_page if str(row.get("id")) == resource_id), None)
        route_tables = (selected or {}).get("route_tables") or []
        route_table_id = str(route_tables[0]) if route_tables else None
    if not route_table_id:
        raise HTTPException(422, "The VPC does not have a route table")
    action = "enable" if payload.enabled else "disable"
    try:
        data, _ = await cloud_v1.call(
            db, user, token, "PUT",
            f"/legacy/api/infra/route-tables/{route_table_id}/{action}-internet-access/",
            project,
            approval=approval,
            timeout_seconds=get_settings().VPC_INTERNET_ACCESS_TIMEOUT_SECONDS,
        )
    except HTTPException:
        await _audit(db, user, "network.vpc.internet_access", "failed", project, "vpc", resource_id, {"enabled": payload.enabled})
        raise
    await _audit(db, user, "network.vpc.internet_access", "success", project, "vpc", resource_id, {"enabled": payload.enabled})
    return data


@router.get("/subnets")
async def subnets(context: CloudContext, user: UserDep, db: Db, page: int = 1, page_size: int = 200):
    return await _list_resource("subnet", context, user, db, page, page_size)


@router.post("/subnets")
async def create_subnet(payload: NetworkResourceCreate, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    return await _create_resource("subnet", payload, context, user, db)


@router.put("/subnets/{resource_id}")
async def update_subnet(resource_id: str, payload: NetworkResourceUpdate, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    return await _update_resource("subnet", resource_id, payload, context, user, db)


@router.delete("/subnets/{resource_id}")
async def delete_subnet(resource_id: str, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    return await _delete_one("subnet", resource_id, context, user, db)


@router.post("/subnets/delete")
async def delete_subnets(payload: NetworkDeleteBatch, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    return await _delete_batch("subnet", payload, context, user, db)


@router.get("/security-groups")
async def security_groups(context: CloudContext, user: UserDep, db: Db, page: int = 1, page_size: int = 200):
    return await _list_resource("security_group", context, user, db, page, page_size)


@router.post("/security-groups")
async def create_security_group(payload: NetworkResourceCreate, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    return await _create_resource("security_group", payload, context, user, db)


@router.put("/security-groups/{resource_id}")
async def update_security_group(resource_id: str, payload: NetworkResourceUpdate, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    return await _update_resource("security_group", resource_id, payload, context, user, db)


@router.delete("/security-groups/{resource_id}")
async def delete_security_group(resource_id: str, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    return await _delete_one("security_group", resource_id, context, user, db)


@router.post("/security-groups/delete")
async def delete_security_groups(payload: NetworkDeleteBatch, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    return await _delete_batch("security_group", payload, context, user, db)


@router.post("/import")
async def import_network(payload: NetworkImportIn, context: CloudContext, user: Operator, _csrf: Csrf, db: Db):
    # Resolve existing and newly-created VPCs by both ID and name. Import is
    # intentionally sequential: VPCs are created before dependent subnets and
    # every row receives an independent result instead of aborting the file.
    existing = await _all_resources("vpc", context, user, db)
    vpc_lookup = {
        key: str(row.get("id"))
        for row in existing
        for key in (str(row.get("id") or ""), str(row.get("name") or "").casefold())
        if key
    }
    regions = await _region_lookup(context, user, db)
    results: dict[str, dict[str, Any]] = {}
    ordered = sorted(payload.items, key=lambda item: 0 if item.resource_type == "vpc" else 1)
    for index, item in enumerate(ordered, start=1):
        create_payload = NetworkResourceCreate(**item.model_dump(exclude={"client_id", "resource_type"}))
        request_body: dict[str, Any] = {}
        if item.resource_type == "subnet" and item.vpc:
            resolved = vpc_lookup.get(item.vpc) or vpc_lookup.get(item.vpc.casefold())
            if not resolved:
                results[item.client_id] = {
                    "client_id": item.client_id,
                    "status": "failed",
                    "request": create_payload.model_dump(exclude_none=True),
                    "response": {"message": f"VPC '{item.vpc}' was not found"},
                    "error": f"VPC '{item.vpc}' was not found",
                }
                continue
            create_payload.vpc = resolved
        try:
            data = await _create_resource(
                item.resource_type,
                create_payload,
                context,
                user,
                db,
                regions,
                request_body,
            )
            results[item.client_id] = {
                "client_id": item.client_id,
                "status": "created",
                "request": request_body,
                "response": data,
                "resource": data,
            }
            if item.resource_type == "vpc" and isinstance(data, dict) and data.get("id"):
                vpc_lookup[str(data["id"])] = str(data["id"])
                vpc_lookup[item.name.casefold()] = str(data["id"])
        except HTTPException as exc:
            results[item.client_id] = {
                "client_id": item.client_id,
                "status": "failed",
                "request": request_body or create_payload.model_dump(exclude_none=True),
                "response": exc.detail,
                "error": exc.detail,
            }
        # Large plans are deliberately sequential to protect the Cloud API. A
        # cooperative yield keeps the API worker responsive between batches.
        if index % 20 == 0:
            await asyncio.sleep(0)
    response_items = [results[item.client_id] for item in payload.items]
    await _audit(
        db, user, "network.import", "success" if all(row["status"] == "created" for row in response_items) else "partial",
        context[0], "network_import", metadata={"total": len(response_items), "created": sum(row["status"] == "created" for row in response_items)},
    )
    return {"items": response_items, "created": sum(row["status"] == "created" for row in response_items), "failed": sum(row["status"] == "failed" for row in response_items)}
