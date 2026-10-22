import secrets
from datetime import datetime
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import Admin, CloudContext, Csrf, Db, Operator
from app.core.config import get_settings
from app.core.time import db_iso
from app.gateway import cloud_v1
from app.models.entities import CloudInitTemplate
from app.provisioning.history import compact_history
from app.provisioning.models import (
    ProvisioningDeployment,
    ProvisioningServerDraft,
    ProvisioningServerLog,
)
from app.provisioning.schemas import DeploymentCreate, ServerDraftSave
from app.provisioning.service import run_deployment
from app.services.audit import write_audit
from app.core.permissions import has_permission
from app.provisioning.agent_network import validate_allocated_network

router = APIRouter(prefix="/provisioning", tags=["provisioning"])
TRANSIENT_CLOUD_STATES = {"", "accepted", "queued", "pending", "creating", "building", "build", "provisioning", "rebooting", "created", "starting", "starting_up"}


@router.get("/deployment-schema")
async def deployment_schema(context: CloudContext, user: Operator):
    """Read the exact current provisioning contract without creating a deployment."""
    return {"schema": DeploymentCreate.model_json_schema()}


def utc_iso(value: datetime | None):
    return db_iso(value)


def view(item: ProvisioningDeployment, details: bool = True):
    payload = {
        "id": item.id, "project_id": item.project_id, "name": item.name,
        "status": item.status, "total_items": item.total_items,
        "succeeded_items": item.succeeded_items, "failed_items": item.failed_items,
        "actor_email": item.actor_email, "error": item.error,
        "created_at": utc_iso(item.created_at), "started_at": utc_iso(item.started_at),
        "completed_at": utc_iso(item.completed_at),
        "execution_mode": (item.manifest_json or {}).get("execution_mode", "standard"),
    }
    if not details:
        names = [row.server_name for row in item.servers]
        payload["server_names"] = names[:5]
    if details:
        payload["template"] = compact_history(item.manifest_json)
        payload["servers"] = [
            {
                "id": row.id, "server_name": row.server_name, "server_id": row.server_id,
                "status": row.status, "error_code": row.error_code,
                "error_message": row.error_message, "request": compact_history(row.request_json),
                "result": compact_history(row.result_json),
                "created_at": utc_iso(row.created_at), "started_at": utc_iso(row.started_at),
                "completed_at": utc_iso(row.completed_at),
            }
            for row in item.servers
        ]
    return payload


async def queue_deployment(body: DeploymentCreate, background: BackgroundTasks, context: CloudContext, user: Operator, db: Db):
    """Shared queueing path for the web route and the narrow Agent Service bridge."""
    project, token, approval = context
    body = await resolve_current_cloud_init_templates(body, project, db)
    correlation = str(uuid4())
    execution_manifest = body.model_dump(mode="json")
    stored_manifest = compact_history(execution_manifest)
    item = ProvisioningDeployment(
        project_id=project, user_id=user.id, actor_email=user.email, name=body.name,
        status="queued", total_items=len(body.servers), manifest_json=stored_manifest,
        correlation_id=correlation,
    )
    item.servers = [
        ProvisioningServerLog(
            server_name=server.name,
            request_json=compact_history({**server.model_dump(mode="json"), "cloud_init_mode": "template" if server.cloud_init_template_id else ("custom" if server.cloud_init_content else "disabled")}),
        ) for server in body.servers
    ]
    db.add(item)
    await db.commit()
    await db.refresh(item)
    await write_audit(
        db, user, "provisioning.deployment.create", "queued", project_id=project,
        target_type="provisioning_deployment", target_id=item.id,
        correlation_id=correlation, metadata={"name": body.name, "servers": len(body.servers)},
    )
    background.add_task(run_deployment, item.id, token, approval, execution_manifest)
    return item


async def resolve_current_cloud_init_templates(body: DeploymentCreate, project: str, db) -> DeploymentCreate:
    """Snapshot current templates at queue time, never execute a stale draft copy."""
    # Templates are shared across projects, matching list_templates/owned.
    # project_id records where a template was created, not an access boundary.
    del project
    templates = {}
    servers = []
    for server in body.servers:
        template_id = server.cloud_init_template_id
        if server.cloud_init_enabled and template_id:
            if template_id not in templates:
                template = await db.get(CloudInitTemplate, template_id)
                if not template:
                    raise HTTPException(400, "Selected cloud-init template is unavailable; select another template")
                templates[template_id] = template
            server = server.model_copy(update={"cloud_init_content": templates[template_id].content})
        servers.append(server)
    return body.model_copy(update={"servers": servers})


@router.get("/server-draft")
async def get_server_draft(context: CloudContext, user: Operator, db: Db):
    """Load the one saved create-list draft for the active cloud project."""
    del user
    project, _, _ = context
    item = await db.scalar(
        select(ProvisioningServerDraft).where(
            ProvisioningServerDraft.project_id == project
        )
    )
    if not item:
        return {"servers": [], "updated_at": None}
    return {
        "servers": item.servers_json if isinstance(item.servers_json, list) else [],
        "updated_at": utc_iso(item.updated_at),
    }


@router.put("/server-draft")
async def save_server_draft(
    body: ServerDraftSave,
    context: CloudContext,
    user: Admin,
    db: Db,
    _csrf: Csrf,
):
    """Replace, rather than append to, the active project's temporary list."""
    project, _, _ = context
    item = await db.scalar(
        select(ProvisioningServerDraft).where(
            ProvisioningServerDraft.project_id == project
        )
    )
    if item is None:
        item = ProvisioningServerDraft(
            project_id=project,
            user_id=user.id,
            servers_json=body.servers,
        )
        db.add(item)
    else:
        item.user_id = user.id
        item.servers_json = body.servers
    await db.commit()
    await db.refresh(item)
    await write_audit(
        db,
        user,
        "provisioning.server_draft.save",
        "success",
        project_id=project,
        target_type="provisioning_server_draft",
        target_id=item.id,
        metadata={"servers": len(body.servers)},
    )
    return {"servers": item.servers_json, "updated_at": utc_iso(item.updated_at)}


@router.post("/deployments", status_code=status.HTTP_202_ACCEPTED)
async def create_deployment(
    body: DeploymentCreate, background: BackgroundTasks, context: CloudContext,
    user: Operator, db: Db, _csrf: Csrf,
):
    item = await queue_deployment(body, background, context, user, db)
    return view(item)


def validate_agent_deployment(body, request, user):
    configured = get_settings().AGENT_SERVICE_BACKEND_KEY or ""
    supplied = request.headers.get("X-Agent-Service-Key", "")
    if not configured or not supplied or not secrets.compare_digest(configured, supplied):
        raise HTTPException(401, "Invalid Agent Service key")
    if user.cloud_api_access != "full" or not has_permission(user, "servers"):
        raise HTTPException(403, "VM creation requires full Cloud access and server permission")
    for server in body.servers:
        missing = []
        if not (server.zone_id or server.zone): missing.append("zone")
        if not (server.image_id or server.image_name): missing.append("image")
        if server.specs_kind == "predefined" and not server.flavor_name: missing.append("flavor_name")
        if server.instance_family == "basic" and not (server.volumes or server.disk_type): missing.append("disk_type or volumes")
        if missing:
            raise HTTPException(422, f"VM {server.name}: select {', '.join(missing)} before requesting approval")


@router.post("/internal/agent/deployments/validate", include_in_schema=False)
async def agent_validate_deployment(body: DeploymentCreate, request: Request, context: CloudContext, user: Operator, db: Db):
    validate_agent_deployment(body, request, user)
    await validate_allocated_network(body, context, user, db)
    return {"deployment": body.model_dump(mode="json")}


@router.post("/internal/agent/deployments", status_code=status.HTTP_202_ACCEPTED, include_in_schema=False)
async def agent_create_deployment(
    body: DeploymentCreate, request: Request, background: BackgroundTasks,
    context: CloudContext, user: Operator, db: Db,
):
    """Service-only queue entry; it deliberately preserves the normal async deployment flow."""
    validate_agent_deployment(body, request, user)
    await validate_allocated_network(body, context, user, db)
    item = await queue_deployment(body, background, context, user, db)
    result = view(item)
    result["status"] = "queued"
    result["poll_url"] = f"/api/v1/provisioning/deployments/{item.id}"
    return result


@router.get("/deployments")
async def deployments(
    project_id: str | None, user: Operator, db: Db, context: CloudContext,
    limit: int = Query(default=20, ge=1, le=100),
):
    del user, project_id
    project, _, _ = context
    rows = (await db.scalars(
        select(ProvisioningDeployment)
        .where(ProvisioningDeployment.project_id == project)
        .options(selectinload(ProvisioningDeployment.servers))
        .order_by(ProvisioningDeployment.created_at.desc()).limit(limit)
    )).all()
    return {"items": [view(row, details=False) for row in rows], "total": len(rows)}


@router.get("/deployments/{deployment_id}")
async def deployment(
    deployment_id: str, user: Operator, db: Db, context: CloudContext,
    refresh_cloud: bool = False,
):
    item = await db.scalar(
        select(ProvisioningDeployment).where(ProvisioningDeployment.id == deployment_id)
        .options(selectinload(ProvisioningDeployment.servers))
    )
    if not item:
        raise HTTPException(404, "Deployment not found")
    project, token, approval = context
    if item.project_id != project:
        raise HTTPException(404, "Deployment not found")
    if refresh_cloud:
        # Fetch the project inventory in pages, then map power states locally.
        # This avoids one Cloud API detail request per created server.
        cloud_servers: dict[str, dict] = {}
        page = 1
        while True:
            inventory, _ = await cloud_v1.list_resource(
                db, user, token, project, "servers", page, 200,
                approval=approval,
            )
            rows = inventory.get("results", [])
            cloud_servers.update(
                {
                    str(server["id"]): server
                    for server in rows
                    if server.get("id")
                }
            )
            if not inventory.get("next"):
                break
            page += 1
        for row in item.servers:
            if not row.server_id or row.status != "succeeded":
                continue
            result = cloud_servers.get(str(row.server_id))
            if result is None:
                row.result_json = {
                    **(row.result_json or {}),
                    "refresh_error": "Server was not found in the project inventory",
                }
                continue
            state = str(result.get("power_state") or result.get("status") or "").lower()
            row.result_json = {
                **(row.result_json or {}), "cloud_state": state or "unknown",
                "stable": state not in TRANSIENT_CLOUD_STATES,
                # Keep actual addresses from the shared inventory response so
                # the deployment result table does not have to infer them from
                # the original create request.
                "private_ips": result.get("private_ip") or result.get("private_ips") or [],
                "elastic_ips": result.get("elastic_ip") or result.get("elastic_ips") or [],
            }
        await db.commit()
    return view(item)


@router.delete("/deployments/{deployment_id}")
async def delete_deployment(
    deployment_id: str, user: Admin, db: Db, context: CloudContext, _csrf: Csrf,
):
    """Delete only completed deployment history for the active project."""
    item = await db.scalar(
        select(ProvisioningDeployment).where(ProvisioningDeployment.id == deployment_id)
    )
    project, _, _ = context
    if not item or item.project_id != project:
        raise HTTPException(404, "Deployment not found")
    if item.status in {"queued", "running", "paused", "stopping"}:
        raise HTTPException(409, "A running deployment cannot be deleted")
    await db.delete(item)
    await db.commit()
    await write_audit(
        db,
        user,
        "provisioning.deployment.delete",
        "succeeded",
        project_id=project,
        target_type="provisioning_deployment",
        target_id=deployment_id,
    )
    return {"deleted": deployment_id}


@router.post("/deployments/{deployment_id}/control")
async def control_deployment(
    deployment_id: str,
    body: dict,
    user: Operator,
    db: Db,
    context: CloudContext,
    _csrf: Csrf,
):
    """Pause, resume or stop only guarded sequential deployments."""
    item = await db.scalar(
        select(ProvisioningDeployment)
        .where(ProvisioningDeployment.id == deployment_id)
        .options(selectinload(ProvisioningDeployment.servers))
    )
    project, _token, _approval = context
    if not item or item.project_id != project:
        raise HTTPException(404, "Deployment not found")
    if (item.manifest_json or {}).get("execution_mode") != "guarded_sequential":
        raise HTTPException(409, "Deployment does not support sequential controls")
    action = str(body.get("action") or "").lower()
    allowed = {
        "pause": ({"queued", "running"}, "paused"),
        "resume": ({"paused"}, "running"),
        "stop": ({"queued", "running", "paused"}, "stopping"),
    }
    if action not in allowed or item.status not in allowed[action][0]:
        raise HTTPException(409, f"Cannot {action or 'control'} a deployment in {item.status} state")
    item.status = allowed[action][1]
    await db.commit()
    await write_audit(
        db, user, "provisioning.deployment.control", action,
        project_id=project, target_type="provisioning_deployment", target_id=item.id,
        correlation_id=item.correlation_id,
    )
    return view(item)
