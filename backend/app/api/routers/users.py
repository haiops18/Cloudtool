from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from app.api.deps import Admin, Csrf, Db
from app.core.permissions import default_permissions
from app.core.security import hash_password
from app.models import Role, User
from app.schemas.common import Page, UserIn, UserOut, UserPatch
from app.services.audit import write_audit

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=Page)
async def list_users(_admin: Admin, db: Db, page: int = 1, page_size: int = 20):
    page, page_size = max(1, page), min(max(1, page_size), 200)
    total = await db.scalar(select(func.count()).select_from(User)) or 0
    rows = (
        await db.scalars(
            select(User)
            .order_by(User.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    return Page(
        items=[UserOut.model_validate(x).model_dump() for x in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("", response_model=UserOut, status_code=201)
async def create_user(payload: UserIn, admin: Admin, _csrf: Csrf, db: Db):
    username = payload.username.lower()
    if await db.scalar(select(User).where(User.username == username)):
        raise HTTPException(409, "Username already exists")
    if await db.scalar(select(User).where(User.email == payload.email.lower())):
        raise HTTPException(409, "Email already exists")
    role = Role(payload.role)
    user = User(
        username=username,
        email=payload.email.lower(),
        full_name=payload.full_name,
        password_hash=hash_password(payload.password),
        role=role,
        permissions=(
            default_permissions(Role.admin)
            if role is Role.admin
            else payload.permissions
            if payload.permissions is not None
            else default_permissions(role)
        ),
        cloud_api_access=(
            "full"
            if role is Role.admin
            else "read"
            if role is Role.viewer
            else payload.cloud_api_access
        ),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    await write_audit(db, admin, "user.create", "success", target_type="user", target_id=user.id)
    return user


@router.patch("/{user_id}", response_model=UserOut)
async def update_user(user_id: str, payload: UserPatch, admin: Admin, _csrf: Csrf, db: Db):
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    changes = payload.model_dump(exclude_unset=True)
    if "username" in changes:
        username = str(changes.pop("username")).lower()
        duplicate = await db.scalar(
            select(User).where(User.username == username, User.id != user.id)
        )
        if duplicate:
            raise HTTPException(409, "Username already exists")
        user.username = username
    if "email" in changes:
        email = str(changes.pop("email")).lower()
        duplicate = await db.scalar(
            select(User).where(User.email == email, User.id != user.id)
        )
        if duplicate:
            raise HTTPException(409, "Email already exists")
        user.email = email
    password = changes.pop("password", None)
    if password:
        user.password_hash = hash_password(password)
    next_role = Role(changes.get("role", user.role))
    next_active = changes.get("is_active", user.is_active)
    if user.role is Role.admin and (next_role is not Role.admin or not next_active):
        active_admins = await db.scalar(
            select(func.count()).select_from(User).where(
                User.role == Role.admin, User.is_active.is_(True)
            )
        )
        if (active_admins or 0) <= 1:
            raise HTTPException(409, "At least one active administrator is required")
    for key, value in changes.items():
        setattr(user, key, Role(value) if key == "role" else value)
    if user.role is Role.admin:
        user.permissions = default_permissions(Role.admin)
        user.cloud_api_access = "full"
    elif user.role is Role.viewer:
        user.cloud_api_access = "read"
    await db.commit()
    await db.refresh(user)
    await write_audit(db, admin, "user.update", "success", target_type="user", target_id=user.id)
    return user


@router.delete("/{user_id}", status_code=204)
async def delete_user(user_id: str, admin: Admin, _csrf: Csrf, db: Db):
    if user_id == admin.id:
        raise HTTPException(409, "You cannot delete your own account")
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if user.role is Role.admin and user.is_active:
        active_admins = await db.scalar(
            select(func.count()).select_from(User).where(
                User.role == Role.admin, User.is_active.is_(True)
            )
        )
        if (active_admins or 0) <= 1:
            raise HTTPException(409, "At least one active administrator is required")
    target_id = user.id
    await db.delete(user)
    await db.commit()
    await write_audit(
        db, admin, "user.delete", "success", target_type="user", target_id=target_id
    )
