from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import or_, select

from app.api.deps import Db
from app.api.routers.auth import set_csrf_cookie
from app.core.config import get_settings
from app.core.security import random_token, token_hash, verify_password
from app.models import Session, User
from app.schemas.common import LoginIn, UserOut
from app.services.audit import write_audit


router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()


@router.post("/login", response_model=UserOut)
async def login_identity(payload: LoginIn, response: Response, db: Db):
    """Login by local username or email, preserving the existing API contract."""
    identifier = (payload.identifier or payload.email or "").strip().lower()
    user = await db.scalar(
        select(User).where(or_(User.username == identifier, User.email == identifier))
    )
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        await write_audit(db, user, "auth.login", "failed")
        raise HTTPException(401, "Invalid username/email or password")
    session_token, csrf = random_token(), random_token()
    db.add(
        Session(
            user_id=user.id,
            session_hash=token_hash(session_token),
            csrf_hash=token_hash(csrf),
            expires_at=datetime.now(UTC) + timedelta(seconds=settings.SESSION_TTL_SECONDS),
        )
    )
    await db.commit()
    response.set_cookie(
        settings.SESSION_COOKIE_NAME,
        session_token,
        httponly=True,
        secure=settings.secure_cookie,
        samesite="strict",
        max_age=settings.SESSION_TTL_SECONDS,
        path="/",
    )
    set_csrf_cookie(response, csrf)
    await write_audit(db, user, "auth.login", "success")
    return UserOut.model_validate(user).model_copy(update={"csrf_token": csrf})
