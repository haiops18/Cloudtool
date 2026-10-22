import re
import secrets

from fastapi import APIRouter, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from app.api.deps import Db
from app.core.config import get_settings
from app.gateway import gateway
from app.models import User
from app.services.terraform_grants import terraform_grants

router = APIRouter(prefix="/terraform-gateway", tags=["terraform-gateway"])
settings = get_settings()

_RESOURCE_ID = r"[0-9a-fA-F-]{8,}"
_RULES = (
    (re.compile(r"^organization/zones/$"), {"GET"}),
    (re.compile(r"^infra/(server-regions|dpcs|volume-type)/$"), {"GET"}),
    (re.compile(r"^infra/(vpcs|vpc|networks|virtual-networks)/$"), {"GET", "POST"}),
    (re.compile(rf"^infra/vpcs/{_RESOURCE_ID}/$"), {"GET", "PUT", "PATCH", "DELETE"}),
    (re.compile(r"^network/vpcs/$"), {"GET"}),
    (
        re.compile(r"^infra/(subnets|keypairs|security-groups|servers|private-ips)/$"),
        {"GET", "POST"},
    ),
    (
        re.compile(
            rf"^infra/(subnets|keypairs|security-groups|servers|private-ips)/{_RESOURCE_ID}/$"
        ),
        {"GET", "PUT", "PATCH", "DELETE"},
    ),
    (re.compile(rf"^infra/servers/{_RESOURCE_ID}/attach-privateip/$"), {"POST"}),
)


def _allowed(method: str, path: str) -> bool:
    return any(pattern.fullmatch(path) and method in methods for pattern, methods in _RULES)


@router.api_route(
    "/{upstream_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"]
)
async def terraform_proxy(
    upstream_path: str,
    request: Request,
    db: Db,
    authorization: str = Header(alias="Authorization"),
    service_token: str = Header(alias="X-Terraform-Service-Token"),
    requested_project: str = Header(alias="Project-ID"),
):
    if not settings.TERRAFORM_SERVICE_TOKEN or not secrets.compare_digest(
        service_token, settings.TERRAFORM_SERVICE_TOKEN
    ):
        raise HTTPException(401, "Invalid Terraform service credential")
    scheme, _, ticket = authorization.partition(" ")
    grant = terraform_grants.get(ticket if scheme.lower() == "bearer" else "")
    if not grant:
        raise HTTPException(401, "Terraform execution ticket is invalid or expired")
    if requested_project != grant.project_id:
        raise HTTPException(403, "Execution ticket is scoped to another project")
    if request.method not in {"GET", "HEAD", "OPTIONS"} and not grant.mutations_allowed:
        raise HTTPException(403, "This Terraform execution is read-only")
    if not _allowed(request.method, upstream_path):
        raise HTTPException(403, "Cloud endpoint is not allowed for Terraform")

    user = await db.get(User, grant.user_id)
    if not user or not user.is_active or user.cloud_api_access != "full":
        raise HTTPException(403, "Terraform actor no longer has write access")

    body = None
    if request.method not in {"GET", "DELETE"} and await request.body():
        try:
            body = await request.json()
        except ValueError as exc:
            raise HTTPException(400, "Terraform request body must be JSON") from exc

    payload, status_code = await gateway.request(
        db,
        user,
        grant.cloud_token,
        request.method,
        f"/{upstream_path}",
        project_id=grant.project_id,
        params=dict(request.query_params),
        body=body,
    )
    if payload is None:
        return Response(status_code=status_code)
    return JSONResponse(payload, status_code=status_code)
