"""normalize server inventory fields

Revision ID: 0008
Revises: 0007
"""

import sqlalchemy as sa
from alembic import op


revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade():
    table = "server_inventory_snapshots"
    scalar_columns = [
        ("inventory_status", sa.String(length=20), "active"),
        ("deleted_at", sa.DateTime(timezone=True), None),
        ("power_state", sa.String(length=80), None),
        ("status", sa.String(length=80), None),
        ("zone", sa.String(length=120), None),
        ("region", sa.String(length=120), None),
        ("server_type", sa.String(length=80), None),
        ("bandwidth", sa.Integer(), None),
        ("flavor_name", sa.String(length=255), None),
        ("image_name", sa.String(length=255), None),
        ("enable_ipv4", sa.Boolean(), None),
        ("enable_elastic_ip", sa.Boolean(), None),
        ("user_data", sa.Text(), None),
        ("cloud_created_at", sa.String(length=80), None),
        ("cloud_updated_at", sa.String(length=80), None),
    ]
    json_columns = [
        "specs", "boot", "key_pair", "placement_group", "private_ip",
        "elastic_ip", "volumes", "security_groups", "metadata",
        "volume_details", "mapped_references", "private_subnets", "extra",
    ]
    for name, type_, default in scalar_columns:
        kwargs = {"nullable": default is None}
        if default is not None:
            kwargs.update({"nullable": False, "server_default": default})
        op.add_column(table, sa.Column(name, type_, **kwargs))
    for name in json_columns:
        op.add_column(table, sa.Column(name, sa.JSON(), nullable=True))
    for name in ("power_state", "status", "zone", "region", "server_type", "flavor_name", "image_name", "inventory_status"):
        op.create_index(f"ix_inventory_{name}", table, [name])


def downgrade():
    table = "server_inventory_snapshots"
    names = [
        "inventory_status", "deleted_at", "power_state", "status", "zone", "region",
        "server_type", "bandwidth", "flavor_name", "image_name", "enable_ipv4",
        "enable_elastic_ip", "user_data", "cloud_created_at", "cloud_updated_at",
        "specs", "boot", "key_pair", "placement_group", "private_ip", "elastic_ip",
        "volumes", "security_groups", "metadata", "volume_details", "mapped_references",
        "private_subnets", "extra",
    ]
    for name in ("power_state", "status", "zone", "region", "server_type", "flavor_name", "image_name", "inventory_status"):
        op.drop_index(f"ix_inventory_{name}", table_name=table)
    for name in reversed(names):
        op.drop_column(table, name)
