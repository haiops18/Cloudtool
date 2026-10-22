"""Store monitor project, VPC and subnet configurations in the database."""

import sqlalchemy as sa
from alembic import op

revision = "0003_monitor_projects"
down_revision = "0002_cli_commands"
branch_labels = None
depends_on = None


def upgrade():
    if sa.inspect(op.get_bind()).has_table("monitor_projects"):
        return
    op.create_table(
        "monitor_projects",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("region", sa.String(length=80), nullable=False),
        sa.Column("monitor_project_id", sa.String(length=100), nullable=False),
        sa.Column("vpc_id", sa.String(length=100), nullable=False),
        sa.Column("vpc_name", sa.String(length=160), nullable=False),
        sa.Column("subnet_id", sa.String(length=100), nullable=False),
        sa.Column("subnet_name", sa.String(length=160), nullable=False),
        sa.Column("subnet_cidr", sa.String(length=80), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("monitor_project_id", "vpc_id"),
    )
    for column in ("name", "region", "monitor_project_id", "vpc_id", "is_active", "created_by", "created_at"):
        op.create_index(op.f(f"ix_monitor_projects_{column}"), "monitor_projects", [column])


def downgrade():
    op.drop_table("monitor_projects")
