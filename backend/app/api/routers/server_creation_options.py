from fastapi import APIRouter, Query

from app.api.deps import CloudContext, Db, UserDep
from app.gateway import cloud_v1

router = APIRouter(prefix="/cloud", tags=["Server creation options"])


@router.get("/server-regions")
async def regions(
    context: CloudContext, user: UserDep, db: Db, q: str | None = None,
    page: int = 1, page_size: int = Query(default=50, ge=1, le=200),
):
    project, token, approval = context
    data, _ = await cloud_v1.call(
        db, user, token, "GET", "/legacy/api/infra/server-regions/", project,
        params={"page": page, "page_size": page_size, **({"q": q} if q else {})},
        approval=approval,
    )
    return {"items": data.get("results", []), "total": data.get("count"),
            "page": page, "page_size": page_size, "next": data.get("next")}


async def option_page(
    db, user, context, resource, page, page_size, *, params=None
):
    project, token, approval = context
    data, _ = await cloud_v1.list_resource(
        db, user, token, project, resource, page, min(page_size, 200),
        params=params, approval=approval,
    )
    return {
        "items": data.get("results", []), "total": data.get("count", 0),
        "page": page, "page_size": page_size, "next": data.get("next"),
    }


@router.get("/server-flavors")
async def flavors(
    context: CloudContext, user: UserDep, db: Db, zone: str,
    family: str = "basic", q: str | None = None, page: int = 1,
    page_size: int = Query(default=50, ge=1, le=200),
):
    params = {"family": family, "zone": zone, "dpc__null": "true"}
    if q:
        params["q"] = q
    return await option_page(db, user, context, "flavors", page, page_size, params=params)


@router.get("/server-images")
async def images(
    context: CloudContext, user: UserDep, db: Db, q: str | None = None,
    page: int = 1, page_size: int = Query(default=50, ge=1, le=200),
):
    params = {"type": "server"}
    if q:
        params["q"] = q
    return await option_page(db, user, context, "images", page, page_size, params=params)


@router.get("/server-keypairs")
async def keypairs(
    context: CloudContext, user: UserDep, db: Db, q: str | None = None,
    page: int = 1, page_size: int = Query(default=50, ge=1, le=200),
):
    return await option_page(db, user, context, "keypairs", page, page_size, params={"q": q} if q else None)


@router.get("/server-vpcs")
async def vpcs(
    context: CloudContext, user: UserDep, db: Db, region_id: str,
    q: str | None = None, page: int = 1,
    page_size: int = Query(default=50, ge=1, le=200),
):
    params = {"region_id": region_id}
    if q:
        params["q"] = q
    return await option_page(db, user, context, "vpcs", page, page_size, params=params)


@router.get("/server-security-groups")
async def security_groups(
    context: CloudContext, user: UserDep, db: Db, region_id: str,
    q: str | None = None, page: int = 1,
    page_size: int = Query(default=50, ge=1, le=200),
):
    params = {"region_id": region_id}
    if q:
        params["q"] = q
    return await option_page(db, user, context, "security-groups", page, page_size, params=params)


@router.get("/server-volume-types")
async def volume_types(
    context: CloudContext, user: UserDep, db: Db, zone: str,
    q: str | None = None, page: int = 1,
    page_size: int = Query(default=50, ge=1, le=200),
):
    params = {"zone": zone, "status": "enabled", "encryption_key_size": 0}
    if q:
        params["q"] = q
    return await option_page(db, user, context, "volume-type", page, page_size, params=params)


@router.get("/server-elastic-ips")
async def elastic_ips(
    context: CloudContext, user: UserDep, db: Db, q: str | None = None,
    page: int = 1, page_size: int = Query(default=50, ge=1, le=200),
):
    params = {"status": "down", "server__isnull": "true"}
    if q:
        params["q"] = q
    result = await option_page(
        db, user, context, "elastic-ips", page, page_size, params=params
    )
    # Keep the creation contract safe even if the upstream ignores the filter.
    result["items"] = [item for item in result["items"] if item.get("server") is None]
    result["total"] = len(result["items"]) if not result.get("next") else result["total"]
    return result


@router.get("/server-placement-groups")
async def placement_groups(
    context: CloudContext, user: UserDep, db: Db, region_id: str,
    q: str | None = None, page: int = 1,
    page_size: int = Query(default=50, ge=1, le=200),
):
    params = {"region": region_id}
    if q:
        params["q"] = q
    return await option_page(
        db, user, context, "placementgroups", page, page_size, params=params
    )


@router.get("/server-enis")
async def enis(
    context: CloudContext, user: UserDep, db: Db, q: str | None = None,
    page: int = 1, page_size: int = Query(default=50, ge=1, le=200),
):
    # Let Viettel Cloud perform the availability filter at source rather than
    # downloading all private IPs and filtering them in the web client.
    params = {"available": "true"}
    if q:
        params["q"] = q
    return await option_page(db, user, context, "private-ips", page, page_size, params=params)
