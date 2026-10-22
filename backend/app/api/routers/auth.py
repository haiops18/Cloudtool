from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import select

from app.api.deps import Csrf, Db, SessionDep, UserDep
from app.core.config import get_settings
from app.core.security import random_token, token_hash, verify_password
from app.models import Session, User
from app.schemas.common import LoginIn, UserOut
from app.services.audit import write_audit

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()


def set_csrf_cookie(response: Response, csrf: str) -> None:
    """Keep a browser's CSRF token stable across tabs and reloads."""
    response.set_cookie(
        settings.CSRF_COOKIE_NAME,
        csrf,
        httponly=False,
        secure=settings.secure_cookie,
        samesite="strict",
        max_age=settings.SESSION_TTL_SECONDS,
        path="/",
    )


async def current_csrf(
    request: Request, response: Response, session: Session, db: Db
) -> str:
    cookie_csrf = request.cookies.get(settings.CSRF_COOKIE_NAME)
    header_csrf = request.headers.get("X-CSRF-Token")
    for candidate in (cookie_csrf, header_csrf):
        if candidate and token_hash(candidate) == session.csrf_hash:
            if candidate != cookie_csrf:
                set_csrf_cookie(response, candidate)
            return candidate
    # Compatibility path for sessions created before the CSRF cookie existed.
    csrf = random_token()
    session.csrf_hash = token_hash(csrf)
    await db.commit()
    set_csrf_cookie(response, csrf)
    return csrf


@router.post("/login", response_model=UserOut)
async def login(payload: LoginIn, response: Response, db: Db):
    user = await db.scalar(select(User).where(User.email == payload.email.lower()))
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        await write_audit(db, user, "auth.login", "failed")
        raise HTTPException(401, "Invalid email or password")
    session_token, csrf = random_token(), random_token()
    session = Session(
        user_id=user.id,
        session_hash=token_hash(session_token),
        csrf_hash=token_hash(csrf),
        expires_at=datetime.now(UTC) + timedelta(seconds=settings.SESSION_TTL_SECONDS),
    )
    db.add(session)
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


@router.get("/me", response_model=UserOut)
async def me(
    request: Request, response: Response, user: UserDep, session: SessionDep, db: Db
):
    csrf = await current_csrf(request, response, session, db)
    # Renew active sessions without rotating the shared cookie across tabs.
    now = datetime.now(UTC)
    if session.expires_at.replace(tzinfo=UTC) - now < timedelta(seconds=settings.SESSION_TTL_SECONDS / 2):
        session.expires_at = now + timedelta(seconds=settings.SESSION_TTL_SECONDS)
        await db.commit()
        session_token = request.cookies.get(settings.SESSION_COOKIE_NAME)
        if session_token:
            response.set_cookie(
                settings.SESSION_COOKIE_NAME, session_token,
                httponly=True, secure=settings.secure_cookie, samesite="strict",
                max_age=settings.SESSION_TTL_SECONDS, path="/",
            )
            set_csrf_cookie(response, csrf)
    return UserOut.model_validate(user).model_copy(update={"csrf_token": csrf})


@router.post("/logout", status_code=204)
async def logout(response: Response, user: UserDep, session: SessionDep, _csrf: Csrf, db: Db):
    session.revoked_at = datetime.now(UTC)
    await db.commit()
    response.delete_cookie(settings.SESSION_COOKIE_NAME, path="/")
    response.delete_cookie(settings.CSRF_COOKIE_NAME, path="/")
    await write_audit(db, user, "auth.logout", "success")
