from datetime import datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.config import get_settings


def app_timezone() -> tzinfo:
    """Timezone used for persisted operational/audit timestamps."""
    configured = get_settings().APP_TIMEZONE
    try:
        return ZoneInfo(configured)
    except ZoneInfoNotFoundError:
        # Windows/Python deployments may not include the optional tzdata
        # package. GMT+7 has no daylight-saving changes, so this is exact for
        # the configured Asia/Bangkok operational timezone.
        if configured in {"Asia/Bangkok", "GMT+7", "UTC+7"}:
            return timezone(timedelta(hours=7), name="GMT+7")
        raise


def db_now() -> datetime:
    """SQLite stores datetimes without an offset; persist the configured wall time."""
    return datetime.now(app_timezone()).replace(tzinfo=None)


def db_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=app_timezone())
    return value.astimezone(app_timezone()).isoformat()
