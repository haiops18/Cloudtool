"""compact all-server inventory IP storage

Revision ID: 0009
Revises: 0008
"""

import json

import sqlalchemy as sa
from alembic import op


revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def _ips(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            pass
    result = []
    for item in value if isinstance(value, list) else [value]:
        if isinstance(item, dict):
            item = item.get("ip_address") or item.get("address") or item.get("ip")
        if isinstance(item, str) and item.strip():
            result.append(item.strip())
    return list(dict.fromkeys(result))


def upgrade():
    table = "all_server_inventory_snapshots"
    op.add_column(table, sa.Column("vip_ip", sa.JSON(), nullable=True))
    bind = op.get_bind()
    rows = bind.execute(sa.text(f"SELECT id, private_ip, elastic_ip FROM {table}")).mappings()
    for row in rows:
        private = row["private_ip"]
        source = json.loads(private) if isinstance(private, str) and private.startswith(("[", "{")) else private
        vips = []
        for item in source if isinstance(source, list) else [source]:
            if isinstance(item, dict):
                vips.extend(_ips(item.get("vips")))
        bind.execute(sa.text(f"UPDATE {table} SET private_ip = :private, vip_ip = :vip, elastic_ip = :elastic WHERE id = :id"), {
            "id": row["id"], "private": json.dumps(_ips(source)), "vip": json.dumps(list(dict.fromkeys(vips))),
            "elastic": json.dumps(_ips(row["elastic_ip"])),
        })
    with op.batch_alter_table(table) as batch:
        for name in ("user_data", "specs", "boot", "key_pair", "placement_group", "volumes", "security_groups", "metadata", "volume_details", "mapped_references", "private_subnets", "extra", "snapshot"):
            batch.drop_column(name)
        batch.create_index("ix_all_inventory_name", ["server_name"])
        batch.create_index("ix_all_inventory_project_name", ["project_name"])
        batch.create_index("ix_all_inventory_zone_name", ["zone_name"])
        batch.create_index("ix_all_inventory_power_state", ["power_state"])


def downgrade():
    # Payload fields intentionally are not reconstructed from the compact cache.
    with op.batch_alter_table("all_server_inventory_snapshots") as batch:
        batch.drop_column("vip_ip")
