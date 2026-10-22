import re
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.api.deps import CloudContext, Csrf, Operator
from app.core.config import get_settings
from app.services.terraform_grants import terraform_grants

router = APIRouter(prefix="/terraform", tags=["terraform"])
settings = get_settings()
_ENVIRONMENT = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")


class TerraformJobIn(BaseModel):
    environment: str
    action: Literal[
        "resolve",
        "plan",
        "plan-save",
        "import-servers",
    ]


async def _service_request(method: str, path: str, **kwargs):
    if not settings.TERRAFORM_SERVICE_URL or not settings.TERRAFORM_SERVICE_TOKEN:
        raise HTTPException(503, "Terraform service is not configured")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.request(
                method,
                f"{settings.TERRAFORM_SERVICE_URL.rstrip('/')}{path}",
                headers={"X-Terraform-Service-Token": settings.TERRAFORM_SERVICE_TOKEN},
                **kwargs,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(503, "Terraform service is unavailable") from exc
    if not response.is_success:
        message = response.text[:1000] or "Terraform service rejected the request"
        raise HTTPException(response.status_code, message)
    return response.json() if response.content else None


@router.get("/health")
async def terraform_health(_user: Operator):
    return await _service_request("GET", "/health")


@router.post("/jobs", status_code=202)
async def create_terraform_job(
    payload: TerraformJobIn,
    context: CloudContext,
    user: Operator,
    _csrf: Csrf,
):
    if not _ENVIRONMENT.fullmatch(payload.environment):
        raise HTTPException(422, "Invalid Terraform environment name")
    project_id, cloud_token, _approval = context
    ticket = terraform_grants.create(
        user.id,
        project_id,
        cloud_token,
        mutations_allowed=False,
    )
    try:
        return await _service_request(
            "POST",
            "/v1/jobs",
            json={
                "environment": payload.environment,
                "action": payload.action,
                "actor_id": user.id,
                "project_id": project_id,
                "gateway_url": settings.TERRAFORM_GATEWAY_URL.rstrip("/")
                + "/api/v1/terraform-gateway",
                "execution_ticket": ticket,
            },
        )
    except Exception:
        terraform_grants.revoke(ticket)
        raise


@router.get("/jobs/{job_id}")
async def terraform_job(job_id: str, user: Operator):
    job = await _service_request("GET", f"/v1/jobs/{job_id}")
    if user.role.value != "admin" and job.get("actor_id") != user.id:
        raise HTTPException(403, "Terraform job belongs to another user")
    return job
