from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from app.api.deps import Csrf, Db, ProfileOperator, ProfileUser
from app.core.config import get_settings
from app.models import PasswordProfile
from app.schemas.common import PasswordProfileIn
from app.services.audit import write_audit

router = APIRouter(prefix="/password-profiles", tags=["password profiles"])


def cipher() -> Fernet:
    key = get_settings().PASSWORD_PROFILE_ENCRYPTION_KEY
    if not key:
        raise HTTPException(503, "Password profile encryption is not configured")
    return Fernet(key.encode())


@router.get("")
async def list_profiles(user: ProfileUser, db: Db):
    rows = (await db.scalars(select(PasswordProfile).order_by(PasswordProfile.name))).all()
    return [
        {
            "id": x.id,
            "name": x.name,
            "username": x.username,
            "is_active": x.is_active,
            "created_at": x.created_at,
        }
        for x in rows
    ]


@router.post("", status_code=201)
async def create_profile(
    payload: PasswordProfileIn, user: ProfileOperator, _csrf: Csrf, db: Db
):
    encrypted = cipher().encrypt(payload.password.encode()).decode()
    item = PasswordProfile(
        name=payload.name, username=payload.username, ciphertext=encrypted, created_by=user.id
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    await write_audit(
        db,
        user,
        "password_profile.create",
        "success",
        target_type="password_profile",
        target_id=item.id,
    )
    return {
        "id": item.id,
        "name": item.name,
        "username": item.username,
        "is_active": item.is_active,
    }


@router.delete("/{profile_id}", status_code=204)
async def delete_profile(
    profile_id: str, user: ProfileOperator, _csrf: Csrf, db: Db
):
    item = await db.get(PasswordProfile, profile_id)
    if not item:
        raise HTTPException(404, "Profile not found")
    await db.delete(item)
    await db.commit()
    await write_audit(
        db,
        user,
        "password_profile.delete",
        "success",
        target_type="password_profile",
        target_id=profile_id,
    )


def decrypt_profile(item: PasswordProfile) -> str:
    try:
        return cipher().decrypt(item.ciphertext.encode()).decode()
    except InvalidToken:
        raise HTTPException(500, "Password profile cannot be decrypted") from None
