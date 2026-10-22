from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, event
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin
from app.models.entities import uid
from app.core.time import db_now


class ProvisioningDeployment(TimestampMixin, Base):
    __tablename__ = "provisioning_deployments"
    __table_args__ = {"schema": "telemetry"}

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(100), index=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    actor_email: Mapped[str | None] = mapped_column(String(320))
    name: Mapped[str] = mapped_column(String(160), default="Server deployment")
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    total_items: Mapped[int] = mapped_column(Integer, default=0)
    succeeded_items: Mapped[int] = mapped_column(Integer, default=0)
    failed_items: Mapped[int] = mapped_column(Integer, default=0)
    manifest_json: Mapped[dict] = mapped_column(JSON, default=dict)
    result_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    correlation_id: Mapped[str] = mapped_column(String(64), index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    servers: Mapped[list["ProvisioningServerLog"]] = relationship(
        back_populates="deployment", cascade="all, delete-orphan", lazy="selectin"
    )


class ProvisioningServerLog(TimestampMixin, Base):
    __tablename__ = "provisioning_server_logs"
    __table_args__ = {"schema": "telemetry"}

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    deployment_id: Mapped[str] = mapped_column(
        ForeignKey("telemetry.provisioning_deployments.id", ondelete="CASCADE"), index=True
    )
    server_name: Mapped[str] = mapped_column(String(160), index=True)
    status: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    server_id: Mapped[str | None] = mapped_column(String(100))
    request_json: Mapped[dict] = mapped_column(JSON, default=dict)
    result_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error_code: Mapped[str | None] = mapped_column(String(80))
    error_message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deployment: Mapped[ProvisioningDeployment] = relationship(back_populates="servers")


class ProvisioningServerDraft(TimestampMixin, Base):
    """The single replaceable server-create draft for one cloud project."""

    __tablename__ = "provisioning_server_drafts"
    __table_args__ = (UniqueConstraint("project_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(100), index=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    servers_json: Mapped[list] = mapped_column(JSON, default=list)


@event.listens_for(ProvisioningDeployment, "before_insert")
@event.listens_for(ProvisioningServerLog, "before_insert")
@event.listens_for(ProvisioningServerDraft, "before_insert")
def _timestamp_provisioning_insert(_mapper, _connection, target):
    target.created_at = db_now()
    target.updated_at = db_now()


@event.listens_for(ProvisioningDeployment, "before_update")
@event.listens_for(ProvisioningServerLog, "before_update")
@event.listens_for(ProvisioningServerDraft, "before_update")
def _timestamp_provisioning_update(_mapper, _connection, target):
    target.updated_at = db_now()
