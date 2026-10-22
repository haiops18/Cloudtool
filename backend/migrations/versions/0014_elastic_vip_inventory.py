"""Store resolved Elastic IP VIP addresses in compact inventory.

Revision ID: 0014
Revises: 0013
"""
import sqlalchemy as sa
from alembic import op

revision = '0014'
down_revision = '0013'
branch_labels = None
depends_on = None


def _schema():
    inspector = sa.inspect(op.get_bind())
    return 'telemetry' if 'telemetry' in inspector.get_schema_names() and inspector.has_table('all_server_inventory_snapshots', schema='telemetry') else None


def upgrade():
    schema = _schema()
    columns = sa.inspect(op.get_bind()).get_columns('all_server_inventory_snapshots', schema=schema)
    if 'elastic_vip_ip' not in {column['name'] for column in columns}:
        op.add_column('all_server_inventory_snapshots', sa.Column('elastic_vip_ip', sa.JSON(), nullable=True), schema=schema)


def downgrade():
    schema = _schema()
    columns = sa.inspect(op.get_bind()).get_columns('all_server_inventory_snapshots', schema=schema)
    if 'elastic_vip_ip' in {column['name'] for column in columns}:
        op.drop_column('all_server_inventory_snapshots', 'elastic_vip_ip', schema=schema)
