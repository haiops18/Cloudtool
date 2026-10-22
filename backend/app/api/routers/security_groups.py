import asyncio

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response, Request, Query
import secrets
from typing import Literal
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_

from app.api.deps import BootstrapContext, CloudContext, Csrf, Db, SecurityGroupUser
from app.core.time import db_now, db_iso
from app.core.config import get_settings
from app.gateway import cloud_v1
from app.models.entities import SecurityGroupRuleDeletionSchedule
from app.schemas.common import (
    SecurityGroupRuleBatch,
    SecurityGroupRuleDeleteBatch,
    SecurityGroupRuleDescriptionUpdate,
    SecurityGroupRuleImportBatch,
)
from app.services.audit import write_audit

router = APIRouter(prefix="/security-groups", tags=["Security groups"])


def _schedule_datetime(value: datetime) -> datetime:
    """Store a naive Bangkok wall-clock value consistently with the app DB."""
    if value.tzinfo is not None:
        return value.astimezone(UTC).replace(tzinfo=None)
    return value


async def set_rule_expiry(
    db, project: str, security_group_id: str, rule_id: str, delete_at: datetime | None
):
    existing = await db.scalar(
        select(SecurityGroupRuleDeletionSchedule).where(
            SecurityGroupRuleDeletionSchedule.project_id == project,
            SecurityGroupRuleDeletionSchedule.rule_id == rule_id,
        )
    )
    if delete_at is None:
        if existing and existing.status == "scheduled":
            await db.delete(existing)
        return
    if existing is None:
        db.add(SecurityGroupRuleDeletionSchedule(
            project_id=project,
            security_group_id=security_group_id,
            rule_id=rule_id,
            delete_at=_schedule_datetime(delete_at),
            rule_created_at=db_now(),
            status="scheduled",
        ))
        return
    existing.security_group_id = security_group_id
    existing.delete_at = _schedule_datetime(delete_at)
    existing.status = "scheduled"
    existing.deleted_at = None
    existing.last_error = None


async def mark_rule_schedule_deleted(db, project: str, rule_id: str, error: str | None = None):
    schedule = await db.scalar(
        select(SecurityGroupRuleDeletionSchedule).where(
            SecurityGroupRuleDeletionSchedule.project_id == project,
            SecurityGroupRuleDeletionSchedule.rule_id == rule_id,
        )
    )
    if schedule:
        schedule.status = "deleted" if not error else "failed"
        schedule.deleted_at = db_now() if not error else None
        schedule.last_error = error


async def all_resource_pages(db, user, token, project, resource, params=None, approval=None, timeout_seconds=None):
    items = []
    page = 1
    while True:
        data, _ = await cloud_v1.list_resource(
            db, user, token, project, resource, page, 200, params, approval,
            **({"timeout_seconds": timeout_seconds} if timeout_seconds is not None else {}),
        )
        page_items = data.get("results", [])
        items.extend(page_items)
        if not data.get("next") or not page_items:
            return items
        page += 1


@router.get("")
async def security_groups(context: CloudContext, user: SecurityGroupUser, db: Db):
    project, token, approval = context
    return await all_resource_pages(
        db, user, token, project, "security-groups", approval=approval
    )


@router.get("/rules")
async def all_security_group_rules(
    context: CloudContext,
    user: SecurityGroupUser,
    db: Db,
    direction: str = "all",
):
    """List project rules once, for the cross-security-group review mode."""
    if direction not in {"all", "ingress", "egress"}:
        raise HTTPException(422, "direction must be all, ingress or egress")
    project, token, approval = context
    params = None if direction == "all" else {"direction": direction}
    return await all_resource_pages(
        db, user, token, project, "security-group-rules", params, approval
    )


@router.post("/rules/import")
async def import_security_group_rules(
    payload: SecurityGroupRuleImportBatch,
    context: CloudContext,
    user: SecurityGroupUser,
    _csrf: Csrf,
    db: Db,
):
    """Create many rules across groups, sequentially and with per-row results."""
    project, token, approval = context
    results = []
    for index, item in enumerate(payload.items, start=1):
        body = item.model_dump(exclude={"client_id", "delete_at"}, exclude_none=True)
        # The UI schema uses security_group_id; Viettel Cloud/OpenStack expects
        # the canonical security_group field in the request body.
        body["security_group"] = body.pop("security_group_id")
        try:
            created, _ = await cloud_v1.call(
                db,
                user,
                token,
                "POST",
                "/legacy/api/infra/security-group-rules/",
                project,
                body=body,
                approval=approval,
            )
            results.append(
                {
                    "client_id": item.client_id,
                    "status": "created",
                    "input": body,
                    "response": created,
                    "rule": created,
                }
            )
            rule_id = str(created.get("id") or "") if isinstance(created, dict) else ""
            if rule_id and item.delete_at:
                await set_rule_expiry(
                    db, project, item.security_group_id, rule_id, item.delete_at
                )
        except HTTPException as exc:
            results.append(
                {
                    "client_id": item.client_id,
                    "status": "failed",
                    "input": body,
                    "response": exc.detail,
                    "error": exc.detail,
                }
            )
        if index % 20 == 0:
            await asyncio.sleep(0)
    await db.commit()
    await write_audit(
        db,
        user,
        "security_group.rules.import",
        "success" if all(item["status"] == "created" for item in results) else "partial",
        project_id=project,
        target_type="security_group_rule_import",
        metadata={
            "count": len(results),
            "failed": sum(item["status"] == "failed" for item in results),
        },
    )
    return {
        "items": results,
        "created": sum(item["status"] == "created" for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
    }


@router.get("/{security_group_id}/rules")
async def security_group_rules(
    security_group_id: str,
    context: CloudContext,
    user: SecurityGroupUser,
    db: Db,
    direction: str = "all",
):
    if direction not in {"all", "ingress", "egress"}:
        raise HTTPException(422, "direction must be all, ingress or egress")
    project, token, approval = context
    directions = ("ingress", "egress") if direction == "all" else (direction,)
    rows = []
    for value in directions:
        rows.extend(
            await all_resource_pages(
                db,
                user,
                token,
                project,
                "security-group-rules",
                {"security_group_id": security_group_id, "direction": value},
                approval,
            )
        )
    rule_ids = [row["id"] for row in rows if row.get("id")]
    schedules = []
    if rule_ids:
        schedules = (
            await db.scalars(
                select(SecurityGroupRuleDeletionSchedule).where(
                    SecurityGroupRuleDeletionSchedule.project_id == project,
                    SecurityGroupRuleDeletionSchedule.security_group_id == security_group_id,
                    SecurityGroupRuleDeletionSchedule.rule_id.in_(rule_ids),
                    SecurityGroupRuleDeletionSchedule.status == "scheduled",
                )
            )
        ).all()
    delete_at_by_rule = {schedule.rule_id: schedule.delete_at for schedule in schedules}
    return [dict(row, delete_at=delete_at_by_rule.get(row.get("id"))) for row in rows]


@router.post("/{security_group_id}/rules")
async def create_security_group_rules(
    security_group_id: str,
    payload: SecurityGroupRuleBatch,
    context: CloudContext,
    user: SecurityGroupUser,
    _csrf: Csrf,
    db: Db,
):
    project, token, approval = context
    results = []
    for index, item in enumerate(payload.items):
        body = item.model_dump(exclude={"delete_at"}, exclude_none=True)
        body["security_group"] = security_group_id
        try:
            created, _ = await cloud_v1.call(
                db,
                user,
                token,
                "POST",
                "/legacy/api/infra/security-group-rules/",
                project,
                body=body,
                approval=approval,
            )
            results.append(
                {"index": index, "status": "created", "input": body, "rule": created}
            )
            rule_id = str(created.get("id") or "") if isinstance(created, dict) else ""
            if rule_id and item.delete_at:
                await set_rule_expiry(db, project, security_group_id, rule_id, item.delete_at)
        except HTTPException as exc:
            results.append(
                {
                    "index": index,
                    "status": "failed",
                    "input": body,
                    # Preserve upstream_detail and other structured Cloud API
                    # fields so the UI can show the actionable message.
                    "error": exc.detail,
                }
            )
    await db.commit()
    await write_audit(
        db,
        user,
        "security_group.rules.create_bulk",
        "completed",
        project_id=project,
        target_type="security_group",
        target_id=security_group_id,
        metadata={"count": len(results), "failed": sum(x["status"] == "failed" for x in results)},
    )
    return {"items": results}


@router.post("/internal/agent/security-group-rule", include_in_schema=False)
async def agent_create_security_group_rule(payload: dict, request: Request, context: CloudContext, user: SecurityGroupUser, db: Db):
    """Narrow service-to-service bridge; normal browser route/CSRF is unchanged."""
    configured = get_settings().AGENT_SERVICE_BACKEND_KEY or ""
    supplied = request.headers.get("X-Agent-Service-Key", "")
    if not configured or not supplied or not secrets.compare_digest(configured, supplied):
        raise HTTPException(401, "Invalid Agent Service key")
    security_group_id, rule = str(payload.get("security_group_id") or ""), payload.get("rule")
    if not security_group_id or not isinstance(rule, dict): raise HTTPException(422, "Invalid security-group rule")
    # Delegate to the established upstream and audit implementation.  The
    # service key authorizes the bridge; the forwarded session still identifies
    # the CloudTool user/project and permission checks remain active.
    batch = SecurityGroupRuleBatch.model_validate({"items": [rule]})
    return await create_security_group_rules(security_group_id, batch, context, user, None, db)


async def delete_rule(db, user, token, project, approval, rule_id):
    await cloud_v1.call(
        db,
        user,
        token,
        "DELETE",
        f"/legacy/api/infra/security-group-rules/{rule_id}/",
        project,
        approval=approval,
    )


@router.put("/{security_group_id}/rules/{rule_id}/description")
async def update_security_group_rule_description(
    security_group_id: str,
    rule_id: str,
    payload: SecurityGroupRuleDescriptionUpdate,
    context: CloudContext,
    user: SecurityGroupUser,
    _csrf: Csrf,
    db: Db,
):
    """Update only a rule description; the Cloud API supports this in place."""
    project, token, approval = context
    result, _ = await cloud_v1.call(
        db,
        user,
        token,
        "PUT",
        f"/legacy/api/infra/security-group-rules/{rule_id}/",
        project,
        body={"description": payload.description},
        approval=approval,
    )
    await set_rule_expiry(db, project, security_group_id, rule_id, payload.delete_at)
    await db.commit()
    await write_audit(
        db,
        user,
        "security_group.rule.description.update",
        "success",
        project_id=project,
        target_type="security_group_rule",
        target_id=rule_id,
        metadata={
            "security_group_id": security_group_id,
            "delete_at": payload.delete_at.isoformat() if payload.delete_at else None,
        },
    )
    return result


class DueRuleDeletion(BaseModel):
    confirmation: Literal["DELETE ALL DUE SG RULES"]
    schedule_ids: list[str] = Field(min_length=1)


async def verified_schedules(db, user, token, approval, rows):
    """Require current project/SG names and exact rule membership before deletion."""
    from app.api.routers.cloud import _accessible_projects

    projects = {item["id"]: item for item in await _accessible_projects(db, user, token, approval)}
    eligible = []
    by_project = {}
    for row in rows:
        by_project.setdefault(row.project_id, []).append(row)
    for project, candidates in by_project.items():
        name = projects.get(project, {}).get("name")
        if not name or name == project:
            continue
        try:
            groups = await all_resource_pages(db, user, token, project, "security-groups", approval=approval)
            rules = await all_resource_pages(db, user, token, project, "security-group-rules", approval=approval)
        except HTTPException:
            continue
        named_groups = {
            str(group.get("id")) for group in groups
            if any(group.get(key) and str(group[key]) != str(group.get("id"))
                   for key in ("display_name", "name"))
        }
        rules_by_id = {str(rule.get("id")): rule for rule in rules}
        for row in candidates:
            rule = rules_by_id.get(row.rule_id)
            if not rule or row.security_group_id not in named_groups:
                continue
            group = rule.get("security_group") or rule.get("security_group_id")
            group_id = group.get("id") if isinstance(group, dict) else group
            if str(group_id or "") == row.security_group_id:
                eligible.append(row)
    return eligible


@router.get("/scheduled-rules/all/due-preview")
async def preview_due_rule_deletion(context: BootstrapContext, user: SecurityGroupUser, db: Db):
    token, approval = context
    rows = (await db.scalars(select(SecurityGroupRuleDeletionSchedule).where(
        SecurityGroupRuleDeletionSchedule.status.in_(("scheduled", "failed")),
        SecurityGroupRuleDeletionSchedule.delete_at <= db_now(),
    ))).all()
    valid = await verified_schedules(db, user, token, approval, rows) if rows else []
    return {"schedule_ids": [row.id for row in valid], "eligible": len(valid), "skipped": len(rows) - len(valid)}


@router.post("/scheduled-rules/all/delete-due")
async def delete_all_due_rules(payload: DueRuleDeletion, context: BootstrapContext, user: SecurityGroupUser, _csrf: Csrf, db: Db):
    token, approval = context
    rows = (await db.scalars(select(SecurityGroupRuleDeletionSchedule).where(
        SecurityGroupRuleDeletionSchedule.id.in_(payload.schedule_ids),
        SecurityGroupRuleDeletionSchedule.status.in_(("scheduled", "failed")),
        SecurityGroupRuleDeletionSchedule.delete_at <= db_now(),
    ))).all()
    valid = await verified_schedules(db, user, token, approval, rows) if rows else []
    grouped = {}
    for row in valid:
        grouped.setdefault(row.project_id, []).append(row.rule_id)
    results = []
    for project, rule_ids in grouped.items():
        for offset in range(0, len(rule_ids), 500):
            response = await delete_scheduled_security_group_rules(
                SecurityGroupRuleDeleteBatch(rule_ids=rule_ids[offset:offset + 500]),
                (project, token, approval), user, _csrf, db,
            )
            results.extend(response["items"])
    return {"items": results, "skipped": len(set(payload.schedule_ids)) - len(valid)}


@router.get("/scheduled-rules/all/project-names")
async def scheduled_rule_project_names(context: BootstrapContext, user: SecurityGroupUser, db: Db):
    # Reuse organization-wide project discovery without depending on servers permission.
    from app.api.routers.cloud import _accessible_projects

    token, approval = context
    projects = await _accessible_projects(db, user, token, approval)
    return {"items": [dict(project,
        name=project.get("name") if project.get("name") != project["id"] else "",
        display_name=project.get("display_name") if project.get("display_name") != project["id"] else "",
    ) for project in projects]}


@router.get("/scheduled-rules/all/projects")
async def all_scheduled_rule_projects(user: SecurityGroupUser, db: Db):
    schedule = SecurityGroupRuleDeletionSchedule
    projects = (await db.scalars(
        select(schedule.project_id).where(
            schedule.status.in_(("scheduled", "failed")), schedule.delete_at.is_not(None)
        ).distinct().order_by(schedule.project_id)
    )).all()
    return {"items": [{"id": project} for project in projects]}


@router.get("/scheduled-rules/all/list")
async def all_scheduled_security_group_rules(
    user: SecurityGroupUser,
    db: Db,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    search: str = Query("", max_length=300),
    project_ids: list[str] = Query(default=[]),
    timing: str = Query("all", pattern="^(all|due|upcoming)$"),
):
    """Read only local schedules; Cloud details are fetched on demand by the UI."""
    schedule = SecurityGroupRuleDeletionSchedule
    filters = [schedule.status.in_(("scheduled", "failed")), schedule.delete_at.is_not(None)]
    now = db_now()
    if project_ids:
        filters.append(schedule.project_id.in_(project_ids))
    if timing == "due":
        filters.append(schedule.delete_at <= now)
    elif timing == "upcoming":
        filters.append(schedule.delete_at > now)
    if search.strip():
        filters.append(or_(*[
            column.icontains(search.strip(), autoescape=True)
            for column in (schedule.project_id, schedule.security_group_id,
                           schedule.rule_id, schedule.last_error)
        ]))
    total = await db.scalar(select(func.count()).select_from(schedule).where(*filters))
    due = await db.scalar(select(func.count()).select_from(schedule).where(
        *filters, schedule.delete_at <= now
    ))
    rows = (await db.scalars(select(schedule).where(*filters).order_by(
        schedule.delete_at, schedule.project_id, schedule.id
    ).offset((page - 1) * page_size).limit(page_size))).all()
    return {
        "items": [{
            "id": row.id, "project_id": row.project_id,
            "security_group_id": row.security_group_id, "rule_id": row.rule_id,
            "delete_at": db_iso(row.delete_at), "rule_created_at": db_iso(row.rule_created_at),
            "last_error": row.last_error,
            "is_due": row.delete_at.replace(tzinfo=None) <= now.replace(tzinfo=None),
        } for row in rows],
        "total": total or 0, "due": due or 0,
        "upcoming": (total or 0) - (due or 0),
        "page": page, "page_size": page_size,
    }


@router.get("/scheduled-rules")
async def security_group_rule_schedules(
    context: CloudContext,
    user: SecurityGroupUser,
    db: Db,
    due_only: bool = False,
    include_rule_details: bool = False,
):
    project, token, approval = context
    query = select(SecurityGroupRuleDeletionSchedule).where(
        SecurityGroupRuleDeletionSchedule.project_id == project,
        SecurityGroupRuleDeletionSchedule.status.in_(("scheduled", "failed")),
    )
    if due_only:
        query = query.where(SecurityGroupRuleDeletionSchedule.delete_at <= db_now())
    rows = (await db.scalars(query.order_by(SecurityGroupRuleDeletionSchedule.delete_at))).all()
    groups, rules = [], []
    if include_rule_details:
        # Keep the schedule table lean (IDs and lifecycle only), then enrich
        # only the explicit management modal from the current Cloud API state.
        # One request owns this DB session, so these reads must be sequential.
        try:
            groups = await all_resource_pages(
                db, user, token, project, "security-groups", approval=approval
            )
            rules = await all_resource_pages(
                db, user, token, project, "security-group-rules", approval=approval
            )
        except HTTPException:
            groups, rules = [], []
    group_names = {
        str(item.get("id")): item.get("display_name") or item.get("name")
        for item in groups
        if isinstance(item, dict) and item.get("id")
    }
    rules_by_id = {
        str(item.get("id")): item
        for item in rules
        if isinstance(item, dict) and item.get("id")
    }
    return {
        "items": [
            {
                "id": row.id,
                "rule_id": row.rule_id,
                "security_group_id": row.security_group_id,
                "delete_at": row.delete_at,
                "rule_created_at": row.rule_created_at,
                "status": row.status,
                "last_error": row.last_error,
                "security_group_name": group_names.get(row.security_group_id),
                "rule": rules_by_id.get(row.rule_id),
            }
            for row in rows
        ]
    }


@router.post("/scheduled-rules/delete")
async def delete_scheduled_security_group_rules(
    payload: SecurityGroupRuleDeleteBatch,
    context: CloudContext,
    user: SecurityGroupUser,
    _csrf: Csrf,
    db: Db,
):
    """Delete selected due rules and retain their schedule audit state."""
    project, token, approval = context
    scheduled = (
        await db.scalars(
            select(SecurityGroupRuleDeletionSchedule).where(
                SecurityGroupRuleDeletionSchedule.project_id == project,
                SecurityGroupRuleDeletionSchedule.rule_id.in_(payload.rule_ids),
                SecurityGroupRuleDeletionSchedule.status.in_(("scheduled", "failed")),
            )
        )
    ).all()
    if payload.verify_exists:
        scheduled = await verified_schedules(db, user, token, approval, scheduled)
    by_rule_id = {row.rule_id: row for row in scheduled}
    results = []
    for rule_id in dict.fromkeys(payload.rule_ids):
        schedule = by_rule_id.get(rule_id)
        if not schedule:
            results.append({"rule_id": rule_id, "status": "failed", "error": "Active deletion schedule was not found"})
            continue
        try:
            await delete_rule(db, user, token, project, approval, rule_id)
            await mark_rule_schedule_deleted(db, project, rule_id)
            results.append({"rule_id": rule_id, "security_group_id": schedule.security_group_id, "status": "deleted"})
        except HTTPException as exc:
            error = str(exc.detail)
            await mark_rule_schedule_deleted(db, project, rule_id, error)
            results.append({"rule_id": rule_id, "security_group_id": schedule.security_group_id, "status": "failed", "error": error})
    await db.commit()
    await write_audit(
        db, user, "security_group.rules.scheduled_delete", "completed",
        project_id=project, target_type="security_group_rule_schedule",
        metadata={"count": len(results), "failed": sum(item["status"] == "failed" for item in results)},
    )
    return {"items": results}


@router.post("/rules/delete")
async def delete_project_security_group_rules(
    payload: SecurityGroupRuleDeleteBatch,
    context: CloudContext,
    user: SecurityGroupUser,
    _csrf: Csrf,
    db: Db,
):
    """Delete selected rules across multiple security groups."""
    project, token, approval = context
    results = []
    for rule_id in dict.fromkeys(payload.rule_ids):
        try:
            await delete_rule(db, user, token, project, approval, rule_id)
            await mark_rule_schedule_deleted(db, project, rule_id)
            results.append({"rule_id": rule_id, "status": "deleted"})
        except HTTPException as exc:
            await mark_rule_schedule_deleted(db, project, rule_id, str(exc.detail))
            results.append({"rule_id": rule_id, "status": "failed", "error": str(exc.detail)})
    await db.commit()
    await write_audit(
        db, user, "security_group.rules.delete_bulk_all", "completed",
        project_id=project, target_type="security_group_rule",
        metadata={"count": len(results), "failed": sum(x["status"] == "failed" for x in results)},
    )
    return {"items": results}


@router.delete("/{security_group_id}/rules/{rule_id}", status_code=204)
async def delete_security_group_rule(
    security_group_id: str,
    rule_id: str,
    context: CloudContext,
    user: SecurityGroupUser,
    _csrf: Csrf,
    db: Db,
):
    project, token, approval = context
    await delete_rule(db, user, token, project, approval, rule_id)
    await mark_rule_schedule_deleted(db, project, rule_id)
    await db.commit()
    await write_audit(
        db, user, "security_group.rule.delete", "success", project_id=project,
        target_type="security_group_rule", target_id=rule_id,
        metadata={"security_group_id": security_group_id},
    )
    return Response(status_code=204)


@router.post("/{security_group_id}/rules/delete")
async def delete_security_group_rules(
    security_group_id: str,
    payload: SecurityGroupRuleDeleteBatch,
    context: CloudContext,
    user: SecurityGroupUser,
    _csrf: Csrf,
    db: Db,
):
    project, token, approval = context
    results = []
    for rule_id in dict.fromkeys(payload.rule_ids):
        try:
            await delete_rule(db, user, token, project, approval, rule_id)
            await mark_rule_schedule_deleted(db, project, rule_id)
            results.append({"rule_id": rule_id, "status": "deleted"})
        except HTTPException as exc:
            await mark_rule_schedule_deleted(db, project, rule_id, str(exc.detail))
            results.append({"rule_id": rule_id, "status": "failed", "error": str(exc.detail)})
    await db.commit()
    await write_audit(
        db, user, "security_group.rules.delete_bulk", "completed", project_id=project,
        target_type="security_group", target_id=security_group_id,
        metadata={"count": len(results), "failed": sum(x["status"] == "failed" for x in results)},
    )
    return {"items": results}
