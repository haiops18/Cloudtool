from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import redact
from app.models import AuditLog, User


async def write_audit(
    db: AsyncSession,
    user: User | None,
    action: str,
    result: str,
    *,
    project_id: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    correlation_id: str | None = None,
    metadata: dict | None = None,
) -> None:
    db.add(
        AuditLog(
            created_at=datetime.now(UTC),
            user_id=user.id if user else None,
            actor_email=user.email if user else None,
            role=user.role.value if user else None,
            action=action,
            result=result,
            project_id=project_id,
            target_type=target_type,
            target_id=target_id,
            correlation_id=correlation_id or str(uuid4()),
            metadata_json=redact(metadata or {}),
        )
    )
    await db.commit()
