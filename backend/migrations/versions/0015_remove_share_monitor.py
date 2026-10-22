"""Remove Share monitor configuration and permissions."""

from alembic import op

from app.db.remove_share_monitor import remove_share_monitor

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade():
    remove_share_monitor(op.get_bind())


def downgrade():
    # Restore the schema only; deleted configurations cannot be recovered.
    from importlib import import_module

    import_module("migrations.versions.0003_monitor_projects").upgrade()
