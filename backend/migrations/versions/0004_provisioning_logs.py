"""Add backend provisioning deployment history."""
import sqlalchemy as sa
from alembic import op

revision = "0004_provisioning_logs"
down_revision = "0003_monitor_projects"
branch_labels = None
depends_on = None

def upgrade():
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("provisioning_deployments"):
        op.create_table("provisioning_deployments",
        sa.Column("id", sa.String(36), primary_key=True), sa.Column("project_id", sa.String(100), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL")), sa.Column("actor_email", sa.String(320)),
        sa.Column("name", sa.String(160), nullable=False), sa.Column("status", sa.String(32), nullable=False),
        sa.Column("total_items", sa.Integer(), nullable=False), sa.Column("succeeded_items", sa.Integer(), nullable=False),
        sa.Column("failed_items", sa.Integer(), nullable=False), sa.Column("manifest_json", sa.JSON(), nullable=False),
        sa.Column("result_json", sa.JSON(), nullable=False), sa.Column("error", sa.Text()), sa.Column("correlation_id", sa.String(64), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)), sa.Column("completed_at", sa.DateTime(timezone=True)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False), sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False))
        for column in ("project_id", "user_id", "status", "correlation_id", "created_at"):
            op.create_index(op.f(f"ix_provisioning_deployments_{column}"), "provisioning_deployments", [column])
    if not inspector.has_table("provisioning_server_logs"):
        op.create_table("provisioning_server_logs",
        sa.Column("id", sa.String(36), primary_key=True), sa.Column("deployment_id", sa.String(36), sa.ForeignKey("provisioning_deployments.id", ondelete="CASCADE"), nullable=False),
        sa.Column("server_name", sa.String(160), nullable=False), sa.Column("status", sa.String(32), nullable=False), sa.Column("server_id", sa.String(100)),
        sa.Column("request_json", sa.JSON(), nullable=False), sa.Column("result_json", sa.JSON(), nullable=False), sa.Column("error_code", sa.String(80)),
        sa.Column("error_message", sa.Text()), sa.Column("started_at", sa.DateTime(timezone=True)), sa.Column("completed_at", sa.DateTime(timezone=True)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False), sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False))
        for column in ("deployment_id", "server_name", "status", "created_at"):
            op.create_index(op.f(f"ix_provisioning_server_logs_{column}"), "provisioning_server_logs", [column])

def downgrade():
    op.drop_table("provisioning_server_logs")
    op.drop_table("provisioning_deployments")
