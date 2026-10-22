from datetime import UTC, datetime
from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.permissions import has_permission
from app.core.security import token_hash
from app.db import get_db
from app.models import Role, Session, User

Db = Annotated[AsyncSession, Depends(get_db)]


def decrypt_session_cloud_token(value: str) -> str:
    """Decrypt only the ephemeral server-side Cloud Authorization session value."""
    from cryptography.fernet import Fernet, InvalidToken

    settings = get_settings()
    key = settings.CLOUD_AUTHORIZATION_ENCRYPTION_KEY or settings.PASSWORD_PROFILE_ENCRYPTION_KEY
    if not key:
        raise HTTPException(503, "Cloud Authorization encryption is not configured")
    try:
        return Fernet(key.encode()).decrypt(value.encode()).decode()
    except (InvalidToken, ValueError):
        raise HTTPException(500, "Cloud Authorization session cannot be decrypted") from None


async def current_session(
    db: Db,
    session_cookie: Annotated[str | None, Cookie(alias=get_settings().SESSION_COOKIE_NAME)] = None,
) -> Session:
    if not session_cookie:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Authentication required")
    item = await db.scalar(
        select(Session).where(Session.session_hash == token_hash(session_cookie))
    )
    now = datetime.now(UTC)
    if not item or item.revoked_at or item.expires_at.replace(tzinfo=UTC) <= now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    return item


async def current_user(db: Db, session: Annotated[Session, Depends(current_session)]) -> User:
    user = await db.get(User, session.user_id)
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account disabled")
    return user


UserDep = Annotated[User, Depends(current_user)]
SessionDep = Annotated[Session, Depends(current_session)]


async def csrf_guard(
    request: Request,
    session: SessionDep,
    csrf: Annotated[str | None, Header(alias="X-CSRF-Token")] = None,
) -> None:
    if request.method not in {"GET", "HEAD", "OPTIONS"} and (
        not csrf or token_hash(csrf) != session.csrf_hash
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid CSRF token")


Csrf = Annotated[None, Depends(csrf_guard)]


def require_roles(*roles: Role):
    async def check(user: UserDep) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        return user

    return check


Operator = Annotated[User, Depends(require_roles(Role.admin, Role.operator))]
Admin = Annotated[User, Depends(require_roles(Role.admin))]


def require_permission(permission: str, *roles: Role):
    async def check(user: UserDep) -> User:
        if roles and user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient role")
        if not has_permission(user, permission):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"Missing feature permission: {permission}",
            )
        return user

    return check


AuditUser = Annotated[User, Depends(require_permission("audit_logs"))]
ProfileUser = Annotated[User, Depends(require_permission("password_profiles"))]
ProfileOperator = Annotated[
    User,
    Depends(
        require_permission("password_profiles", Role.admin, Role.operator)
    ),
]
CliCommandUser = Annotated[User, Depends(require_permission("servers"))]
SecurityGroupUser = Annotated[User, Depends(require_permission("security_groups"))]


def cloud_context(
    session: SessionDep,
    project_id: Annotated[str | None, Header(alias="X-Project-Id")] = None,
    token: Annotated[str | None, Header(alias="X-Cloud-Token")] = None,
    approval: Annotated[str | None, Header(alias="X-Cloud-Approval")] = None,
) -> tuple[str, str, str | None]:
    # Existing feature pages may still send the legacy header. Once a user has
    # selected a server-side Cloud Authorization, it is authoritative so a UI
    # compatibility placeholder can never replace the real secret.
    token = (
        decrypt_session_cloud_token(session.cloud_token_ciphertext)
        if session.cloud_token_ciphertext
        else token
    )
    project_id = project_id or session.cloud_project_id
    if not project_id or not token:
        raise HTTPException(400, "Select a project and Cloud Authorization")
    return project_id, token, approval


CloudContext = Annotated[tuple[str, str, str | None], Depends(cloud_context)]


def bootstrap_context(
    session: SessionDep,
    token: Annotated[str | None, Header(alias="X-Cloud-Token")] = None,
    approval: Annotated[str | None, Header(alias="X-Cloud-Approval")] = None,
) -> tuple[str, str | None]:
    token = (
        decrypt_session_cloud_token(session.cloud_token_ciphertext)
        if session.cloud_token_ciphertext
        else token
    )
    if not token:
        raise HTTPException(400, "Select a Cloud Authorization first")
    return token, approval


BootstrapContext = Annotated[tuple[str, str | None], Depends(bootstrap_context)]
