import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    event,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.time import db_now
from app.db.base import Base, TimestampMixin


def uid() -> str:
    return str(uuid.uuid4())


class Role(str, enum.Enum):
    admin = "admin"
    operator = "operator"
    viewer = "viewer"


class User(TimestampMixin, Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    username: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[Role] = mapped_column(Enum(Role), default=Role.viewer, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    permissions: Mapped[list] = mapped_column(JSON, default=list)
    cloud_api_access: Mapped[str] = mapped_column(String(20), default="read")


class Session(TimestampMixin, Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    session_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    csrf_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Ephemeral cloud context. This is encrypted at rest and is removed when
    # the browser session expires or signs out; it is never returned to a client.
    cloud_token_ciphertext: Mapped[str | None] = mapped_column(Text)
    cloud_authorization_id: Mapped[str | None] = mapped_column(String(36), index=True)
    cloud_project_id: Mapped[str | None] = mapped_column(String(100))
    user: Mapped[User] = relationship()


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = {"schema": "telemetry"}
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    actor_email: Mapped[str | None] = mapped_column(String(320))
    role: Mapped[str | None] = mapped_column(String(32))
    action: Mapped[str] = mapped_column(String(120), index=True)
    target_type: Mapped[str | None] = mapped_column(String(80))
    target_id: Mapped[str | None] = mapped_column(String(200))
    project_id: Mapped[str | None] = mapped_column(String(36), index=True)
    correlation_id: Mapped[str] = mapped_column(String(64), index=True)
    result: Mapped[str] = mapped_column(String(40), index=True)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)


class CloudApiLog(Base):
    __tablename__ = "cloud_api_logs"
    __table_args__ = {"schema": "telemetry"}
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    project_id: Mapped[str | None] = mapped_column(String(36), index=True)
    correlation_id: Mapped[str] = mapped_column(String(64), index=True)
    method: Mapped[str] = mapped_column(String(10))
    endpoint: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(30), index=True)
    http_status: Mapped[int | None] = mapped_column(Integer)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(String(80))
    request_meta: Mapped[dict] = mapped_column(JSON, default=dict)
    response_meta: Mapped[dict] = mapped_column(JSON, default=dict)


@event.listens_for(AuditLog, "before_insert")
def _timestamp_audit_log(_mapper, _connection, target):
    target.created_at = db_now()


@event.listens_for(CloudApiLog, "before_insert")
def _timestamp_cloud_api_log(_mapper, _connection, target):
    target.created_at = db_now()


class PasswordProfile(TimestampMixin, Base):
    __tablename__ = "password_profiles"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    username: Mapped[str] = mapped_column(String(120))
    ciphertext: Mapped[str] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))


class CloudAuthorization(TimestampMixin, Base):
    """A user-owned, encrypted Viettel Cloud Authorization saved for reuse."""

    __tablename__ = "cloud_authorizations"
    __table_args__ = (UniqueConstraint("user_id", "name"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    ciphertext: Mapped[str] = mapped_column(Text)
    last_project_id: Mapped[str | None] = mapped_column(String(100))
    last_project_name: Mapped[str | None] = mapped_column(String(200))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)


class CliCommand(TimestampMixin, Base):
    __tablename__ = "cli_commands"
    __table_args__ = (UniqueConstraint("created_by", "name"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(80), default="General", index=True)
    description: Mapped[str] = mapped_column(String(500), default="")
    command: Mapped[str] = mapped_column(Text)
    shared_variables: Mapped[dict] = mapped_column(JSON, default=dict)
    is_favorite: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_by: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )


class PrometheusLink(TimestampMixin, Base):
    __tablename__ = "prometheus_links"
    __table_args__ = (UniqueConstraint("created_by", "name"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(120))
    url: Mapped[str] = mapped_column(String(500))
    auth_type: Mapped[str] = mapped_column(String(30), default="none")
    ciphertext: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )


class TeleportLink(TimestampMixin, Base):
    __tablename__ = "teleport_links"
    __table_args__ = (UniqueConstraint("created_by", "name"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(120))
    url: Mapped[str] = mapped_column(String(500))
    verify_tls: Mapped[bool] = mapped_column(Boolean, default=True)
    tsh_path: Mapped[str] = mapped_column(String(1000), default="")
    session_ciphertext: Mapped[str | None] = mapped_column(Text)
    session_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)


class CloudInitTemplate(TimestampMixin, Base):
    __tablename__ = "cloud_init_templates"
    __table_args__ = (UniqueConstraint("project_id", "name"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(36), index=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    os_family: Mapped[str] = mapped_column(String(20), default="any", index=True)
    description: Mapped[str] = mapped_column(String(500), default="")
    content: Mapped[str] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    is_starred: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)


class BatchExecution(TimestampMixin, Base):
    __tablename__ = "batch_executions"
    __table_args__ = (UniqueConstraint("user_id", "idempotency_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    project_id: Mapped[str] = mapped_column(String(36), index=True)
    kind: Mapped[str] = mapped_column(String(80), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(100))
    payload_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), index=True)
    total_items: Mapped[int] = mapped_column(Integer, default=0)
    succeeded_items: Mapped[int] = mapped_column(Integer, default=0)
    failed_items: Mapped[int] = mapped_column(Integer, default=0)


class ResourceMarker(Base):
    __tablename__ = "resource_markers"
    __table_args__ = (Index("ix_marker_lookup", "project_id", "resource_type", "resource_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(36), index=True)
    resource_type: Mapped[str] = mapped_column(String(40))
    resource_id: Mapped[str] = mapped_column(String(100))
    batch_id: Mapped[str | None] = mapped_column(
        ForeignKey("batch_executions.id", ondelete="SET NULL")
    )
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    marked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    result: Mapped[str] = mapped_column(String(40))


class ServerInventorySnapshot(Base):
    """Latest server detail, normalized for database-side filtering and sorting.

    Scalar Cloud API fields live in their own columns.  Values that are
    inherently nested (for example volumes and security groups) remain JSON,
    which preserves the upstream detail without turning the inventory table
    into an unbounded dynamic schema.
    """

    __tablename__ = "server_inventory_snapshots"
    __table_args__ = (
        UniqueConstraint("project_id", "server_id"),
        Index("ix_server_inventory_project_refresh", "project_id", "refreshed_at"),
        {"schema": "telemetry"},
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(36), index=True)
    server_id: Mapped[str] = mapped_column(String(100), index=True)
    server_name: Mapped[str] = mapped_column(String(255), default="")
    refreshed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    inventory_status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    power_state: Mapped[str | None] = mapped_column(String(80), index=True)
    status: Mapped[str | None] = mapped_column(String(80), index=True)
    zone: Mapped[str | None] = mapped_column(String(120), index=True)
    region: Mapped[str | None] = mapped_column(String(120), index=True)
    server_type: Mapped[str | None] = mapped_column(String(80), index=True)
    bandwidth: Mapped[int | None] = mapped_column(Integer)
    flavor_name: Mapped[str | None] = mapped_column(String(255), index=True)
    image_name: Mapped[str | None] = mapped_column(String(255), index=True)
    enable_ipv4: Mapped[bool | None] = mapped_column(Boolean)
    enable_elastic_ip: Mapped[bool | None] = mapped_column(Boolean)
    user_data: Mapped[str | None] = mapped_column(Text)
    cloud_created_at: Mapped[str | None] = mapped_column(String(80), index=True)
    cloud_updated_at: Mapped[str | None] = mapped_column(String(80), index=True)
    specs: Mapped[dict | None] = mapped_column(JSON)
    boot: Mapped[dict | None] = mapped_column(JSON)
    key_pair: Mapped[object | None] = mapped_column(JSON)
    placement_group: Mapped[object | None] = mapped_column(JSON)
    private_ip: Mapped[list | None] = mapped_column(JSON)
    elastic_ip: Mapped[list | None] = mapped_column(JSON)
    volumes: Mapped[list | None] = mapped_column(JSON)
    security_groups: Mapped[list | None] = mapped_column(JSON)
    metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON)
    volume_details: Mapped[list | None] = mapped_column(JSON)
    mapped_references: Mapped[dict | None] = mapped_column(JSON)
    private_subnets: Mapped[list | None] = mapped_column(JSON)
    extra: Mapped[dict] = mapped_column(JSON, default=dict)
    # Compatibility only: older SQLite databases retain this NOT NULL column.
    # New inventory data is stored in the normalized columns above, so inserts
    # write an empty document rather than duplicating the full server payload.
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)


class AllServerInventorySnapshot(Base):
    """Lean cross-project VM inventory used by the All Servers screen."""

    __tablename__ = "all_server_inventory_snapshots"
    __table_args__ = (
        UniqueConstraint("project_id", "server_id"),
        Index("ix_all_inventory_project_refresh", "project_id", "refreshed_at"),
        Index("ix_all_inventory_name", "server_name"),
        Index("ix_all_inventory_project_name", "project_name"),
        Index("ix_all_inventory_zone_name", "zone_name"),
        Index("ix_all_inventory_power_state", "power_state"),
        {"schema": "telemetry"},
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(36), index=True)
    project_name: Mapped[str] = mapped_column(String(255), default="", index=True)
    project_display_name: Mapped[str] = mapped_column(String(255), default="", index=True)
    server_id: Mapped[str] = mapped_column(String(100), index=True)
    server_name: Mapped[str] = mapped_column(String(255), default="")
    refreshed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    inventory_status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    power_state: Mapped[str | None] = mapped_column(String(80), index=True)
    status: Mapped[str | None] = mapped_column(String(80), index=True)
    zone: Mapped[str | None] = mapped_column(String(120), index=True)
    zone_name: Mapped[str | None] = mapped_column(String(255), index=True)
    region: Mapped[str | None] = mapped_column(String(120), index=True)
    server_type: Mapped[str | None] = mapped_column(String(80), index=True)
    bandwidth: Mapped[int | None] = mapped_column(Integer)
    flavor_name: Mapped[str | None] = mapped_column(String(255), index=True)
    image_name: Mapped[str | None] = mapped_column(String(255), index=True)
    enable_ipv4: Mapped[bool | None] = mapped_column(Boolean)
    enable_elastic_ip: Mapped[bool | None] = mapped_column(Boolean)
    cloud_created_at: Mapped[str | None] = mapped_column(String(80), index=True)
    cloud_updated_at: Mapped[str | None] = mapped_column(String(80), index=True)
    # Arrays contain canonical string IPs, never Cloud API objects or metadata.
    private_ip: Mapped[list | None] = mapped_column(JSON)
    vip_ip: Mapped[list | None] = mapped_column(JSON)
    elastic_ip: Mapped[list | None] = mapped_column(JSON)
    elastic_vip_ip: Mapped[list | None] = mapped_column(JSON)


class SecurityGroupRuleDeletionSchedule(Base):
    """Optional CloudTool-managed expiry for an upstream security-group rule."""

    __tablename__ = "security_group_rule_deletion_schedules"
    __table_args__ = (
        UniqueConstraint("project_id", "rule_id"),
        Index("ix_sg_rule_schedule_due", "project_id", "status", "delete_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(100), index=True)
    security_group_id: Mapped[str] = mapped_column(String(100), index=True)
    rule_id: Mapped[str] = mapped_column(String(100), index=True)
    delete_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    rule_created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=db_now)
    status: Mapped[str] = mapped_column(String(20), default="scheduled", index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)


class UserSetting(TimestampMixin, Base):
    __tablename__ = "user_settings"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    page_size: Mapped[int] = mapped_column(Integer, default=20)
    timezone: Mapped[str] = mapped_column(String(80), default="Asia/Bangkok")
    theme: Mapped[str] = mapped_column(String(20), default="system")
