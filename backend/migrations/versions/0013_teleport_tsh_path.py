"""store selected tsh binary per teleport link

Revision ID: 0013
Revises: 0012
"""
import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade():
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("teleport_links")}
    if "tsh_path" not in columns:
        op.add_column(
            "teleport_links",
            sa.Column("tsh_path", sa.String(length=1000), nullable=False, server_default=""),
        )


def downgrade():
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("teleport_links")}
    if "tsh_path" in columns:
        op.drop_column("teleport_links", "tsh_path")
