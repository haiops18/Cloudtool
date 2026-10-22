from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, model_validator

from app.api.deps import CloudContext, Csrf, Db, require_permission
from app.gateway import cloud_v1
from app.models import User
from app.services.audit import write_audit

router = APIRouter(prefix="/vpc-peerings", tags=["VPC peerings"])
PeeringUser = Annotated[User, Depends(require_permission("private_ips"))]
UPSTREAM = "/legacy/api/infra/vpc-peerings/"


class PeeringCreate(BaseModel):
    requester_vpc: UUID
    accepter_vpc: UUID
    description: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def different_vpcs(self):
        if self.requester_vpc == self.accepter_vpc:
            raise ValueError("Source and peer VPC must be different")
        return self


async def _catalog(resource, context, user, db):
    project, token, approval = context
    data, _ = await cloud_v1.list_resource(
        db, user, token, project, resource, 1, 200, approval=approval
    )
    return data.get("results", [])


def _id(value):
    return value.get("id") if isinstance(value, dict) else value


async def _connection(peering_id, context, user, db):
    # The documented API has no detail endpoint. Re-read the project list to
    # check membership and status before forwarding a mutation.
    project = context[0]
    rows = await _catalog("vpc-peerings", context, user, db)
    row = next((item for item in rows if item.get("id") == str(peering_id)), None)
    if row is None:
        raise HTTPException(404, "VPC peering not found in the current project")
    if project not in {_id(row.get("requester_project")), _id(row.get("accepter_project"))}:
        raise HTTPException(403, "VPC peering does not belong to the current project")
    return row


@router.get("")
async def list_peerings(context: CloudContext, user: PeeringUser, db: Db):
    return await _catalog("vpc-peerings", context, user, db)


@router.get("/vpcs")
async def list_vpcs(context: CloudContext, user: PeeringUser, db: Db, project_id: UUID | None = None):
    if project_id is not None and str(project_id) != context[0]:
        projects = await list_projects(context, user, db)
        if str(project_id) not in {item["id"] for item in projects}:
            raise HTTPException(403, "Peer project is not accessible to this account")
        context = (str(project_id), context[1], context[2])
    return await _catalog("vpcs", context, user, db)


@router.get("/projects")
async def list_projects(context: CloudContext, user: PeeringUser, db: Db):
    from app.api.routers.cloud import _accessible_projects

    return await _accessible_projects(db, user, context[1], context[2])


@router.post("", status_code=201)
async def create_peering(
    payload: PeeringCreate, context: CloudContext, user: PeeringUser, _csrf: Csrf, db: Db
):
    vpcs = await _catalog("vpcs", context, user, db)
    if not any(item.get("id") == str(payload.requester_vpc) for item in vpcs):
        raise HTTPException(422, "Source VPC must belong to the current project")
    project, token, approval = context
    data, _ = await cloud_v1.call(
        db, user, token, "POST", UPSTREAM, project,
        body=payload.model_dump(mode="json"), approval=approval,
    )
    await write_audit(db, user, "vpc_peering.create", "success", project_id=project)
    return data


@router.post("/{peering_id}/{action}", status_code=202)
async def respond_peering(
    peering_id: UUID, action: Literal["accept", "reject"], context: CloudContext,
    user: PeeringUser, _csrf: Csrf, db: Db,
):
    row = await _connection(peering_id, context, user, db)
    if row.get("status") != "pending":
        raise HTTPException(409, "Only pending VPC peerings can be accepted or rejected")
    project, token, approval = context
    await cloud_v1.call(
        db, user, token, "POST", f"{UPSTREAM}{peering_id}/{action}/", project,
        approval=approval,
    )
    await write_audit(
        db, user, f"vpc_peering.{action}", "accepted", project_id=project,
        target_type="vpc_peering", target_id=str(peering_id),
    )
    return Response(status_code=202)


@router.delete("/{peering_id}", status_code=204)
async def delete_peering(
    peering_id: UUID, context: CloudContext, user: PeeringUser, _csrf: Csrf, db: Db
):
    await _connection(peering_id, context, user, db)
    project, token, approval = context
    await cloud_v1.call(
        db, user, token, "DELETE", f"{UPSTREAM}{peering_id}/", project, approval=approval
    )
    await write_audit(
        db, user, "vpc_peering.delete", "success", project_id=project,
        target_type="vpc_peering", target_id=str(peering_id),
    )
    return Response(status_code=204)
