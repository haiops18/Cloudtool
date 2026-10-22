"""add cloud-init template star

Revision ID: 0006
Revises: 0005
"""
import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "cloud_init_templates",
        sa.Column("is_starred", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index(
        "ix_cloud_init_templates_is_starred",
        "cloud_init_templates",
        ["is_starred"],
    )


def downgrade():
    op.drop_index("ix_cloud_init_templates_is_starred", table_name="cloud_init_templates")
    op.drop_column("cloud_init_templates", "is_starred")
