"""Add the per-user CLI command library."""

import sqlalchemy as sa
from alembic import op

revision = "0002_cli_commands"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "cli_commands",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("category", sa.String(length=80), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column("command", sa.Text(), nullable=False),
        sa.Column("is_favorite", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("created_by", "name"),
    )
    op.create_index(op.f("ix_cli_commands_category"), "cli_commands", ["category"])
    op.create_index(op.f("ix_cli_commands_created_at"), "cli_commands", ["created_at"])
    op.create_index(op.f("ix_cli_commands_created_by"), "cli_commands", ["created_by"])
    op.create_index(op.f("ix_cli_commands_is_favorite"), "cli_commands", ["is_favorite"])


def downgrade():
    op.drop_index(op.f("ix_cli_commands_is_favorite"), table_name="cli_commands")
    op.drop_index(op.f("ix_cli_commands_created_by"), table_name="cli_commands")
    op.drop_index(op.f("ix_cli_commands_created_at"), table_name="cli_commands")
    op.drop_index(op.f("ix_cli_commands_category"), table_name="cli_commands")
    op.drop_table("cli_commands")
