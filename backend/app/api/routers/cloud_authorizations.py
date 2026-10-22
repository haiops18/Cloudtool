"""Secure, user-owned Cloud Authorization contexts.

Secrets are only accepted over the authenticated API, encrypted with Fernet
before persistence, and are never included in a response or audit payload.
"""

from datetime import UTC, datetime

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import Csrf, Db, SessionDep, UserDep
from app.core.config import get_settings
from app.core.time import db_iso
from app.models.entities import AuditLog, CloudAuthorization
from app.services.audit import write_audit

router = APIRouter(prefix="/cloud-authorizations", tags=["cloud authorizations"])


def cipher() -> Fernet:
    key = get_settings().CLOUD_AUTHORIZATION_ENCRYPTION_KEY or get_settings().PASSWORD_PROFILE_ENCRYPTION_KEY
    if not key:
        raise HTTPException(503, "Cloud Authorization encryption is not configured")
    try:
        return Fernet(key.encode())
    except (TypeError, ValueError):
        raise HTTPException(503, "Cloud Authorization encryption key is invalid") from None


def normalize_authorization(value: str, scheme: str) -> str:
    value = value.strip()
    if not value:
        raise HTTPException(422, "Cloud Authorization is required")
    if scheme not in {"token", "bearer", "custom"}:
        raise HTTPException(422, "Unsupported authorization scheme")
    if scheme == "custom" or value.lower().startswith(("token ", "bearer ")):
        return value
    return f"{'Token' if scheme == 'token' else 'Bearer'} {value}"


def decrypt(value: str) -> str:
    try:
        return cipher().decrypt(value.encode()).decode()
    except InvalidToken:
        raise HTTPException(500, "Saved Cloud Authorization cannot be decrypted") from None


def item_out(item: CloudAuthorization, active_id: str | None) -> dict:
    return {
        "id": item.id,
        "name": item.name,
        "last_project_id": item.last_project_id,
        "last_project_name": item.last_project_name,
        "last_used_at": item.last_used_at,
        "created_at": item.created_at,
        "is_active": item.id == active_id,
    }


class ActivateIn(BaseModel):
    authorization: str = Field(min_length=3, max_length=10000)
    scheme: str = "token"
    save: bool = False
    name: str | None = Field(None, max_length=160)


class RenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)


class ProjectIn(BaseModel):
    project_id: str = Field(min_length=1, max_length=100)
    project_name: str | None = Field(None, max_length=200)


@router.get("")
async def list_authorizations(user: UserDep, session: SessionDep, db: Db):
    rows = (await db.scalars(
        select(CloudAuthorization)
        .where(CloudAuthorization.user_id == user.id)
        .order_by(CloudAuthorization.last_used_at.desc(), CloudAuthorization.name)
    )).all()
    active = next((item for item in rows if item.id == session.cloud_authorization_id), None)
    return {
        "items": [item_out(item, session.cloud_authorization_id) for item in rows],
        "has_session_authorization": bool(session.cloud_token_ciphertext),
        "active_authorization_id": session.cloud_authorization_id,
        "active_project_id": session.cloud_project_id,
        "active_project_name": active.last_project_name if active else None,
    }


@router.get("/history")
async def authorization_history(
    user: UserDep, db: Db,
    offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100),
):
    rows = (await db.execute(
        select(AuditLog, CloudAuthorization)
        .outerjoin(CloudAuthorization, (CloudAuthorization.id == AuditLog.target_id)
                   & (CloudAuthorization.user_id == user.id))
        .where(
            AuditLog.user_id == user.id,
            AuditLog.action.in_(["cloud_authorization.activate", "cloud_authorization.activate_saved"]),
            AuditLog.result == "success",
        )
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .offset(offset).limit(limit + 1)
    )).all()
    items = []
    for event, saved in rows[:limit]:
        metadata = event.metadata_json or {}
        is_saved = event.target_id is not None
        items.append({
            "id": event.id,
            "authorization_id": saved.id if saved else None,
            "name": metadata.get("display_name") or (saved.name if saved else (
                "Deleted authorization" if is_saved else "Session token"
            )),
            "project_name": metadata.get("project_name"),
            "logged_in_at": db_iso(event.created_at),
            "kind": "saved" if is_saved else "session",
        })
    return {"items": items, "has_more": len(rows) > limit}


@router.post("/activate")
async def activate_authorization(
    payload: ActivateIn, user: UserDep, session: SessionDep, _csrf: Csrf, db: Db
):
    secret = normalize_authorization(payload.authorization, payload.scheme)
    saved: CloudAuthorization | None = None
    if payload.save:
        name = (payload.name or "").strip() or "Saved Cloud Authorization"
        saved = await db.scalar(
            select(CloudAuthorization).where(
                CloudAuthorization.user_id == user.id, CloudAuthorization.name == name
            )
        )
        if saved:
            saved.ciphertext = cipher().encrypt(secret.encode()).decode()
        else:
            saved = CloudAuthorization(
                user_id=user.id, name=name, ciphertext=cipher().encrypt(secret.encode()).decode()
            )
            db.add(saved)
        await db.flush()
    session.cloud_token_ciphertext = cipher().encrypt(secret.encode()).decode()
    session.cloud_authorization_id = saved.id if saved else None
    session.cloud_project_id = None
    await db.commit()
    await write_audit(
        db, user, "cloud_authorization.activate", "success",
        target_type="cloud_authorization", target_id=saved.id if saved else None,
        metadata={"saved": bool(saved), "display_name": saved.name if saved else "Session token"},
    )
    return {"saved": item_out(saved, saved.id) if saved else None, "session_only": not bool(saved)}


@router.post("/{authorization_id}/activate")
async def activate_saved_authorization(
    authorization_id: str, user: UserDep, session: SessionDep, _csrf: Csrf, db: Db
):
    item = await db.scalar(
        select(CloudAuthorization).where(
            CloudAuthorization.id == authorization_id, CloudAuthorization.user_id == user.id
        )
    )
    if not item:
        raise HTTPException(404, "Saved Cloud Authorization not found")
    session.cloud_token_ciphertext = cipher().encrypt(decrypt(item.ciphertext).encode()).decode()
    session.cloud_authorization_id = item.id
    session.cloud_project_id = item.last_project_id
    item.last_used_at = datetime.now(UTC)
    await db.commit()
    await write_audit(
        db, user, "cloud_authorization.activate_saved", "success",
        target_type="cloud_authorization", target_id=item.id,
        metadata={"display_name": item.name, "project_name": item.last_project_name},
    )
    return item_out(item, item.id)


@router.post("/project")
async def remember_project(payload: ProjectIn, user: UserDep, session: SessionDep, _csrf: Csrf, db: Db):
    if not session.cloud_token_ciphertext:
        raise HTTPException(400, "Select a Cloud Authorization first")
    session.cloud_project_id = payload.project_id
    if session.cloud_authorization_id:
        item = await db.get(CloudAuthorization, session.cloud_authorization_id)
        if item and item.user_id == user.id:
            # A blank saved label becomes meaningful as soon as the user picks
            # a project, while an explicitly chosen label is never changed.
            if item.name == "Saved Cloud Authorization" and payload.project_name:
                duplicate = await db.scalar(
                    select(CloudAuthorization.id).where(
                        CloudAuthorization.user_id == user.id,
                        CloudAuthorization.name == payload.project_name,
                        CloudAuthorization.id != item.id,
                    )
                )
                if not duplicate:
                    item.name = payload.project_name
            item.last_project_id = payload.project_id
            item.last_project_name = payload.project_name
            item.last_used_at = datetime.now(UTC)
    await db.commit()
    return {"project_id": payload.project_id}


@router.patch("/{authorization_id}")
async def rename_authorization(authorization_id: str, payload: RenameIn, user: UserDep, _csrf: Csrf, db: Db):
    item = await db.scalar(select(CloudAuthorization).where(CloudAuthorization.id == authorization_id, CloudAuthorization.user_id == user.id))
    if not item:
        raise HTTPException(404, "Saved Cloud Authorization not found")
    item.name = payload.name.strip()
    await db.commit()
    return item_out(item, None)


@router.delete("/{authorization_id}", status_code=204)
async def delete_authorization(authorization_id: str, user: UserDep, session: SessionDep, _csrf: Csrf, db: Db):
    item = await db.scalar(select(CloudAuthorization).where(CloudAuthorization.id == authorization_id, CloudAuthorization.user_id == user.id))
    if not item:
        raise HTTPException(404, "Saved Cloud Authorization not found")
    if session.cloud_authorization_id == item.id:
        session.cloud_authorization_id = None
        session.cloud_token_ciphertext = None
        session.cloud_project_id = None
    await db.delete(item)
    await db.commit()
    await write_audit(db, user, "cloud_authorization.delete", "success", target_type="cloud_authorization", target_id=authorization_id)


@router.post("/clear", status_code=204)
async def clear_session_authorization(user: UserDep, session: SessionDep, _csrf: Csrf, db: Db):
    session.cloud_token_ciphertext = None
    session.cloud_authorization_id = None
    session.cloud_project_id = None
    await db.commit()
    await write_audit(db, user, "cloud_authorization.clear", "success")
