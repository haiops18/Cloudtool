"""persist encrypted teleport sessions

Revision ID: 0012
Revises: 0011
"""
import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("teleport_links", sa.Column("session_ciphertext", sa.Text(), nullable=True))
    op.add_column("teleport_links", sa.Column("session_expires_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    op.drop_column("teleport_links", "session_expires_at")
    op.drop_column("teleport_links", "session_ciphertext")
