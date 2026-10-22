import re
from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import Admin, CloudContext, Csrf, Db, Operator
from app.models.entities import CloudInitTemplate
from app.services.audit import write_audit
from app.provisioning.variables import VARIABLE_PATTERN, cloud_init_values
from app.provisioning.schemas import ServerSpec

router = APIRouter(prefix="/cloud-init-templates", tags=["Cloud-init templates"])


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    os_family: Literal["any", "ubuntu", "centos", "debian", "windows", "oracle"] = "any"
    description: str = Field(default="", max_length=500)
    content: str = Field(min_length=1, max_length=262_144)
    is_active: bool = True
    is_starred: bool = False


class TemplatePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    os_family: Literal["any", "ubuntu", "centos", "debian", "windows", "oracle"] | None = None
    description: str | None = Field(default=None, max_length=500)
    content: str | None = Field(default=None, min_length=1, max_length=262_144)
    is_active: bool | None = None
    is_starred: bool | None = None


def output(item: CloudInitTemplate):
    return {
        "id": item.id, "project_id": item.project_id, "name": item.name,
        "os_family": item.os_family, "description": item.description,
        "content": item.content, "is_active": item.is_active,
        "is_starred": item.is_starred,
        "created_at": item.created_at, "updated_at": item.updated_at,
    }


@router.get("")
async def list_templates(context: CloudContext, user: Operator, db: Db):
    del context, user
    rows = (await db.scalars(
        select(CloudInitTemplate)
        .order_by(CloudInitTemplate.is_active.desc(), CloudInitTemplate.name)
    )).all()
    return {"items": [output(item) for item in rows], "total": len(rows)}


@router.post("", status_code=201)
async def create_template(
    payload: TemplateIn, context: CloudContext, user: Admin, _csrf: Csrf, db: Db
):
    project, _, _ = context
    item = CloudInitTemplate(project_id=project, created_by=user.id, **payload.model_dump())
    db.add(item)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "A cloud-init template with this name already exists") from None
    await db.refresh(item)
    await write_audit(db, user, "cloud_init_template.create", "success", project_id=project, target_type="cloud_init_template", target_id=item.id, metadata={"name": item.name})
    return output(item)


async def owned(template_id: str, db: Db):
    item = await db.get(CloudInitTemplate, template_id)
    if not item:
        raise HTTPException(404, "Cloud-init template not found")
    return item


@router.get("/{template_id}/planning-options")
async def template_planning_options(template_id: str, context: CloudContext, user: Operator, db: Db):
    """Describe a shared template's inputs without returning executable content."""
    item = await owned(template_id, db)
    variables = sorted(set(VARIABLE_PATTERN.findall(item.content)))
    builtins = set(cloud_init_values(ServerSpec(name="metadata", subnet_name="metadata")))
    def automatic(name):
        return name in builtins or bool(re.fullmatch(
            r"(?:data_)?volume(?:\[\d+\]\.(?:mount_path|type|size)|_\d+_(?:mount_path|type|size))", name))
    return {"id": item.id, "name": item.name, "description": item.description,
            "os_family": item.os_family, "is_active": item.is_active,
            "variables": variables,
            "derived_variables": [v for v in variables if automatic(v)],
            "custom_variables": [v for v in variables if not automatic(v)],
            "note": "Derived network/IP variables can depend on the selected allocation. No script or secret values are returned."}


@router.patch("/{template_id}")
async def update_template(
    template_id: str, payload: TemplatePatch, context: CloudContext,
    user: Admin, _csrf: Csrf, db: Db,
):
    project, _, _ = context
    item = await owned(template_id, db)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, key, value)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "A cloud-init template with this name already exists") from None
    await db.refresh(item)
    await write_audit(db, user, "cloud_init_template.update", "success", project_id=project, target_type="cloud_init_template", target_id=item.id, metadata={"name": item.name})
    return output(item)


@router.delete("/{template_id}", status_code=204)
async def delete_template(
    template_id: str, context: CloudContext, user: Admin, _csrf: Csrf, db: Db
):
    project, _, _ = context
    item = await owned(template_id, db)
    name = item.name
    await db.delete(item); await db.commit()
    await write_audit(db, user, "cloud_init_template.delete", "success", project_id=project, target_type="cloud_init_template", target_id=template_id, metadata={"name": name})
    return Response(status_code=204)
