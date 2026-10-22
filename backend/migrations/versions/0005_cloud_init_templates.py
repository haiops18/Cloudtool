"""cloud-init templates

Revision ID: 0005
Revises: 0004_provisioning_logs
"""
import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004_provisioning_logs"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "cloud_init_templates",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("os_family", sa.String(20), nullable=False, server_default="any"),
        sa.Column("description", sa.String(500), nullable=False, server_default=""),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("project_id", "name"),
    )
    op.create_index("ix_cloud_init_templates_project_id", "cloud_init_templates", ["project_id"])


def downgrade():
    op.drop_index("ix_cloud_init_templates_project_id", table_name="cloud_init_templates")
    op.drop_table("cloud_init_templates")
