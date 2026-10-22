"""add encrypted cloud authorizations

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("sessions", sa.Column("cloud_token_ciphertext", sa.Text(), nullable=True))
    op.add_column("sessions", sa.Column("cloud_authorization_id", sa.String(length=36), nullable=True))
    op.add_column("sessions", sa.Column("cloud_project_id", sa.String(length=100), nullable=True))
    op.create_index("ix_sessions_cloud_authorization_id", "sessions", ["cloud_authorization_id"])
    op.create_table(
        "cloud_authorizations",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("ciphertext", sa.Text(), nullable=False),
        sa.Column("last_project_id", sa.String(length=100)),
        sa.Column("last_project_name", sa.String(length=200)),
        sa.Column("last_used_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "name"),
    )
    op.create_index("ix_cloud_authorizations_user_id", "cloud_authorizations", ["user_id"])
    op.create_index("ix_cloud_authorizations_name", "cloud_authorizations", ["name"])
    op.create_index("ix_cloud_authorizations_last_used_at", "cloud_authorizations", ["last_used_at"])


def downgrade():
    op.drop_index("ix_cloud_authorizations_last_used_at", table_name="cloud_authorizations")
    op.drop_index("ix_cloud_authorizations_name", table_name="cloud_authorizations")
    op.drop_index("ix_cloud_authorizations_user_id", table_name="cloud_authorizations")
    op.drop_table("cloud_authorizations")
    op.drop_index("ix_sessions_cloud_authorization_id", table_name="sessions")
    op.drop_column("sessions", "cloud_project_id")
    op.drop_column("sessions", "cloud_authorization_id")
    op.drop_column("sessions", "cloud_token_ciphertext")
