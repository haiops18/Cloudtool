from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import Csrf, Db, UserDep
from app.core.config import get_settings
from app.models import UserSetting
from app.services.audit import write_audit

router = APIRouter(tags=["settings"])


class SettingIn(BaseModel):
    page_size: int = Field(ge=5)
    timezone: str = Field(min_length=1, max_length=80)
    theme: str = Field(pattern="^(light|dark|system)$")


@router.get("/runtime-config")
async def runtime_config():
    value = get_settings()
    return {
        "page_size_default": value.PAGE_SIZE_DEFAULT,
        "page_size_max": value.PAGE_SIZE_MAX,
        "token_max_idle_seconds": value.TOKEN_MAX_IDLE_SECONDS,
        "debug_cloud_approval_mode": value.DEBUG_CLOUD_APPROVAL_MODE,
    }


@router.get("/settings")
async def get_user_settings(user: UserDep, db: Db):
    item = await db.get(UserSetting, user.id)
    return {
        "page_size": item.page_size if item else get_settings().PAGE_SIZE_DEFAULT,
        "timezone": item.timezone if item else "Asia/Bangkok",
        "theme": item.theme if item else "system",
    }


@router.put("/settings")
async def update_settings(payload: SettingIn, user: UserDep, _csrf: Csrf, db: Db):
    if payload.page_size > get_settings().PAGE_SIZE_MAX:
        raise HTTPException(422, "Page size exceeds server maximum")
    item = await db.get(UserSetting, user.id) or UserSetting(user_id=user.id)
    item.page_size, item.timezone, item.theme = payload.page_size, payload.timezone, payload.theme
    db.add(item)
    await db.commit()
    await write_audit(db, user, "settings.update", "success")
    return payload
