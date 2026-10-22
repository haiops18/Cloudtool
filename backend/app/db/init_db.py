import json

from sqlalchemy import inspect, select, text

from app.core.config import get_settings
from app.core.permissions import default_permissions
from app.core.security import hash_password
from app.db.base import Base
from app.db.remove_share_monitor import remove_share_monitor
from app.db.session import SessionFactory, engine
from app.models import Role, User
from app.provisioning import models as provisioning_models  # noqa: F401


def migrate_user_permissions(connection) -> None:
    columns = {column["name"] for column in inspect(connection).get_columns("users")}
    if "permissions" not in columns:
        connection.execute(text("ALTER TABLE users ADD COLUMN permissions JSON"))
    if "cloud_api_access" not in columns:
        connection.execute(
            text("ALTER TABLE users ADD COLUMN cloud_api_access VARCHAR(20)")
        )
    if "username" not in columns:
        connection.execute(text("ALTER TABLE users ADD COLUMN username VARCHAR(120)"))
        connection.execute(
            text(
                "UPDATE users SET username = lower(substr(email, 1, instr(email || '@', '@') - 1)) "
                "WHERE username IS NULL OR username = ''"
            )
        )
        connection.execute(
            text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users (username)")
        )


def migrate_cli_command_variables(connection) -> None:
    columns = {
        column["name"] for column in inspect(connection).get_columns("cli_commands")
    }
    if "shared_variables" not in columns:
        connection.execute(
            text("ALTER TABLE cli_commands ADD COLUMN shared_variables JSON")
        )


def migrate_cloud_init_template_star(connection) -> None:
    tables = set(inspect(connection).get_table_names())
    if "cloud_init_templates" not in tables:
        return
    columns = {
        column["name"]
        for column in inspect(connection).get_columns("cloud_init_templates")
    }
    if "is_starred" not in columns:
        connection.execute(
            text(
                "ALTER TABLE cloud_init_templates "
                "ADD COLUMN is_starred BOOLEAN NOT NULL DEFAULT 0"
            )
        )
    connection.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_cloud_init_templates_is_starred "
            "ON cloud_init_templates (is_starred)"
        )
    )


def migrate_session_cloud_context(connection) -> None:
    tables = set(inspect(connection).get_table_names())
    if "sessions" not in tables:
        return
    columns = {column["name"] for column in inspect(connection).get_columns("sessions")}
    additions = {
        "project_name": "VARCHAR(255) NOT NULL DEFAULT ''",
        "cloud_token_ciphertext": "TEXT",
        "cloud_authorization_id": "VARCHAR(36)",
        "cloud_project_id": "VARCHAR(100)",
    }
    for name, definition in additions.items():
        if name not in columns:
            connection.execute(text(f"ALTER TABLE sessions ADD COLUMN {name} {definition}"))
    connection.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_sessions_cloud_authorization_id "
            "ON sessions (cloud_authorization_id)"
        )
    )


def migrate_server_inventory_columns(connection) -> None:
    """Normalize legacy JSON snapshots without changing the inventory API.

    SQLite cannot index useful values inside the old `snapshot` document well.
    Keep nested data as JSON columns, move filterable scalar data into columns,
    and clear the retired document after every existing row is converted.
    """
    table = "server_inventory_snapshots"
    if table not in set(inspect(connection).get_table_names()):
        return
    columns = {column["name"] for column in inspect(connection).get_columns(table)}
    # DATETIME is accepted by SQLite but PostgreSQL has no such type.
    # These DDL statements run at application startup on both engines.
    datetime_type = "TIMESTAMP" if connection.dialect.name == "postgresql" else "DATETIME"
    additions = {
        "inventory_status": "VARCHAR(20) NOT NULL DEFAULT 'active'",
        "deleted_at": datetime_type,
        "power_state": "VARCHAR(80)", "status": "VARCHAR(80)",
        "zone": "VARCHAR(120)", "region": "VARCHAR(120)",
        "server_type": "VARCHAR(80)", "bandwidth": "INTEGER",
        "flavor_name": "VARCHAR(255)", "image_name": "VARCHAR(255)",
        "enable_ipv4": "BOOLEAN", "enable_elastic_ip": "BOOLEAN",
        "user_data": "TEXT", "cloud_created_at": "VARCHAR(80)",
        "cloud_updated_at": "VARCHAR(80)",
        "specs": "JSON", "boot": "JSON", "key_pair": "JSON",
        "placement_group": "JSON", "private_ip": "JSON", "elastic_ip": "JSON",
        "volumes": "JSON", "security_groups": "JSON", "metadata": "JSON",
        "volume_details": "JSON", "mapped_references": "JSON",
        "private_subnets": "JSON", "extra": "JSON",
    }
    for name, definition in additions.items():
        if name not in columns:
            connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {definition}"))

    for name in ("power_state", "status", "zone", "region", "server_type", "flavor_name", "image_name", "inventory_status"):
        connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_inventory_{name} ON {table} ({name})"))

    if "snapshot" not in columns:
        return
    scalar_fields = {
        "power_state", "status", "zone", "region", "server_type", "bandwidth",
        "flavor_name", "image_name", "enable_ipv4", "enable_elastic_ip", "user_data",
    }
    json_fields = {
        "specs", "boot", "key_pair", "placement_group", "private_ip", "elastic_ip",
        "volumes", "security_groups", "metadata", "volume_details",
        "mapped_references", "private_subnets",
    }
    handled = scalar_fields | json_fields | {
        "id", "name", "project", "created_at", "updated_at", "inventory_status", "deleted_at",
    }
    rows = connection.execute(text(f"SELECT id, snapshot FROM {table}")).mappings()
    for source in rows:
        snapshot = source["snapshot"]
        if isinstance(snapshot, str):
            try:
                snapshot = json.loads(snapshot)
            except json.JSONDecodeError:
                snapshot = {}
        if not isinstance(snapshot, dict) or not snapshot:
            continue
        values = {field: snapshot.get(field) for field in scalar_fields}
        values.update({field: json.dumps(snapshot.get(field)) if snapshot.get(field) is not None else None for field in json_fields})
        values["cloud_created_at"] = snapshot.get("created_at")
        values["cloud_updated_at"] = snapshot.get("updated_at")
        values["inventory_status"] = snapshot.get("inventory_status") or "active"
        values["deleted_at"] = snapshot.get("deleted_at")
        values["extra"] = json.dumps({key: value for key, value in snapshot.items() if key not in handled})
        values["id"] = source["id"]
        assignments = ", ".join(f"{name} = :{name}" for name in values if name != "id")
        connection.execute(text(f"UPDATE {table} SET {assignments}, snapshot = '{{}}' WHERE id = :id"), values)


def migrate_all_server_inventory_columns(connection) -> None:
    """Compact All Servers storage and flatten Cloud API IP objects to strings."""
    table = "all_server_inventory_snapshots"
    if table not in set(inspect(connection).get_table_names()):
        return
    columns = {column["name"] for column in inspect(connection).get_columns(table)}
    if "vip_ip" in columns:
        return

    def parsed(value):
        if isinstance(value, str):
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return value
        return value

    def ips(value):
        result = []
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, dict):
                item = item.get("ip_address") or item.get("address") or item.get("ip")
            if isinstance(item, str) and item.strip():
                result.append(item.strip())
        return list(dict.fromkeys(result))

    rows = connection.execute(text(f"SELECT * FROM {table}")).mappings().all()
    # SQLite's DROP COLUMN is not available in every deployed version. Rebuild
    # the isolated cache table, which also physically releases old JSON blobs.
    if connection.dialect.name == "sqlite":
        connection.execute(text(f"ALTER TABLE {table} RENAME TO {table}_legacy_compact"))
        connection.execute(text(f'''CREATE TABLE {table} (
            id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL,
            project_name VARCHAR(255) NOT NULL DEFAULT '', project_display_name VARCHAR(255) NOT NULL DEFAULT '',
            server_id VARCHAR(100) NOT NULL, server_name VARCHAR(255) NOT NULL DEFAULT '',
            refreshed_at DATETIME NOT NULL, inventory_status VARCHAR(20) NOT NULL DEFAULT 'active', deleted_at DATETIME,
            power_state VARCHAR(80), status VARCHAR(80), zone VARCHAR(120), zone_name VARCHAR(255), region VARCHAR(120),
            server_type VARCHAR(80), bandwidth INTEGER, flavor_name VARCHAR(255), image_name VARCHAR(255),
            enable_ipv4 BOOLEAN, enable_elastic_ip BOOLEAN, cloud_created_at VARCHAR(80), cloud_updated_at VARCHAR(80),
            private_ip JSON, vip_ip JSON, elastic_ip JSON,
            UNIQUE(project_id, server_id)
        )'''))
    else:
        connection.execute(text(f"ALTER TABLE {table} ADD COLUMN vip_ip JSON"))

    insert = text(f'''INSERT INTO {table} (
        id, project_id, project_name, project_display_name, server_id, server_name, refreshed_at, inventory_status, deleted_at,
        power_state, status, zone, zone_name, region, server_type, bandwidth, flavor_name, image_name, enable_ipv4,
        enable_elastic_ip, cloud_created_at, cloud_updated_at, private_ip, vip_ip, elastic_ip
    ) VALUES (
        :id, :project_id, :project_name, :project_display_name, :server_id, :server_name, :refreshed_at, :inventory_status, :deleted_at,
        :power_state, :status, :zone, :zone_name, :region, :server_type, :bandwidth, :flavor_name, :image_name, :enable_ipv4,
        :enable_elastic_ip, :cloud_created_at, :cloud_updated_at, :private_ip, :vip_ip, :elastic_ip
    )''')
    for source in rows:
        private = parsed(source.get("private_ip"))
        vip = []
        for item in private if isinstance(private, list) else [private]:
            if isinstance(item, dict):
                vip.extend(ips(item.get("vips")))
        values = {name: source.get(name) for name in (
            "id", "project_id", "project_name", "project_display_name", "server_id", "server_name", "refreshed_at",
            "inventory_status", "deleted_at", "power_state", "status", "zone", "zone_name", "region", "server_type",
            "bandwidth", "flavor_name", "image_name", "enable_ipv4", "enable_elastic_ip", "cloud_created_at", "cloud_updated_at",
        )}
        values.update({"project_name": source.get("project_name") or "", "project_display_name": source.get("project_display_name") or "",
                       "server_name": source.get("server_name") or "", "inventory_status": source.get("inventory_status") or "active",
                       "private_ip": json.dumps(ips(private)), "vip_ip": json.dumps(list(dict.fromkeys(vip))),
                       "elastic_ip": json.dumps(ips(parsed(source.get("elastic_ip"))))})
        if connection.dialect.name == "sqlite":
            connection.execute(insert, values)
        else:
            connection.execute(text(f'''UPDATE {table} SET private_ip = :private_ip,
                vip_ip = :vip_ip, elastic_ip = :elastic_ip WHERE id = :id'''), values)
    if connection.dialect.name == "sqlite":
        connection.execute(text(f"DROP TABLE {table}_legacy_compact"))
    for name, field in (("ix_all_inventory_project_refresh", "project_id, refreshed_at"), ("ix_all_inventory_name", "server_name"),
                        ("ix_all_inventory_project_name", "project_name"), ("ix_all_inventory_zone_name", "zone_name"),
                        ("ix_all_inventory_power_state", "power_state")):
        connection.execute(text(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({field})"))


def migrate_elastic_vip_inventory_column(connection) -> None:
    inspector = inspect(connection)
    table = "all_server_inventory_snapshots"
    schema = "telemetry" if "telemetry" in inspector.get_schema_names() and inspector.has_table(table, schema="telemetry") else None
    if not inspector.has_table(table, schema=schema):
        return
    if "elastic_vip_ip" not in {column["name"] for column in inspector.get_columns(table, schema=schema)}:
        qualified = f"telemetry.{table}" if schema else table
        connection.execute(text(f"ALTER TABLE {qualified} ADD COLUMN elastic_vip_ip JSON"))


def migrate_operational_timestamps_to_bangkok(connection) -> None:
    """One-time SQLite migration from legacy UTC wall-clock values to GMT+7."""
    # SQLite's datetime() modifier is not PostgreSQL syntax.  PostgreSQL data is
    # already migrated as a separate database migration, so never apply this
    # legacy SQLite wall-clock conversion to it.
    if connection.dialect.name != "sqlite":
        return
    migration = "timestamps_utc_to_asia_bangkok_v1"
    connection.execute(
        text(
            "CREATE TABLE IF NOT EXISTS system_migrations "
            "(name VARCHAR(120) PRIMARY KEY, applied_at DATETIME NOT NULL)"
        )
    )
    if connection.execute(
        text("SELECT 1 FROM system_migrations WHERE name = :name"),
        {"name": migration},
    ).scalar():
        return
    inspector = inspect(connection)
    targets = {
        "audit_logs": ("created_at",),
        "cloud_api_logs": ("created_at", "completed_at"),
        "provisioning_deployments": ("created_at", "updated_at", "started_at", "completed_at"),
        "provisioning_server_logs": ("created_at", "updated_at", "started_at", "completed_at"),
        "server_inventory_snapshots": ("refreshed_at",),
        "resource_markers": ("marked_at",),
    }
    tables = set(inspector.get_table_names())
    for table, columns in targets.items():
        if table not in tables:
            continue
        existing = {column["name"] for column in inspector.get_columns(table)}
        for column in columns:
            if column in existing:
                connection.execute(
                    text(
                        f"UPDATE {table} SET {column} = datetime({column}, '+7 hours') "
                        f"WHERE {column} IS NOT NULL"
                    )
                )
    connection.execute(
        text("INSERT INTO system_migrations (name, applied_at) VALUES (:name, CURRENT_TIMESTAMP)"),
        {"name": migration},
    )


def migrate_large_tables_to_telemetry(connection) -> None:
    """Move legacy operational tables into the attached telemetry SQLite file.

    The copy is idempotent and only drops a source table after every source row
    is present in telemetry.  This keeps application queries unchanged because
    SQLAlchemy maps these models to the attached ``telemetry`` schema.
    """
    if connection.dialect.name != "sqlite":
        return
    source_tables = set(inspect(connection).get_table_names())
    telemetry_tables = set(inspect(connection).get_table_names(schema="telemetry"))
    tables = (
        "provisioning_deployments", "provisioning_server_logs",
        "audit_logs", "cloud_api_logs", "server_inventory_snapshots",
        "all_server_inventory_snapshots",
    )
    for table in tables:
        if table not in source_tables or table not in telemetry_tables:
            continue
        columns = [column["name"] for column in inspect(connection).get_columns(table)]
        quoted = ", ".join(f'"{column}"' for column in columns)
        connection.execute(text(f'INSERT OR IGNORE INTO telemetry."{table}" ({quoted}) SELECT {quoted} FROM main."{table}"'))
        source_count = connection.execute(text(f'SELECT COUNT(*) FROM main."{table}"')).scalar_one()
        target_count = connection.execute(text(f'SELECT COUNT(*) FROM telemetry."{table}"')).scalar_one()
        if target_count < source_count:
            raise RuntimeError(f"Telemetry migration verification failed for {table}")
    # Drop child first permits SQLite to remove the old FK-constrained tables.
    for table in ("provisioning_server_logs", "provisioning_deployments", "audit_logs", "cloud_api_logs", "server_inventory_snapshots", "all_server_inventory_snapshots"):
        if table in source_tables and table in telemetry_tables:
            connection.execute(text(f'DROP TABLE main."{table}"'))


async def init_database() -> None:
    settings = get_settings()
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(migrate_user_permissions)
        await connection.run_sync(remove_share_monitor)
        await connection.run_sync(migrate_cli_command_variables)
        await connection.run_sync(migrate_cloud_init_template_star)
        await connection.run_sync(migrate_session_cloud_context)
        await connection.run_sync(migrate_server_inventory_columns)
        await connection.run_sync(migrate_all_server_inventory_columns)
        await connection.run_sync(migrate_operational_timestamps_to_bangkok)
        await connection.run_sync(migrate_elastic_vip_inventory_column)
        await connection.run_sync(migrate_large_tables_to_telemetry)
    async with SessionFactory() as db:
        users = (await db.scalars(select(User))).all()
        changed = False
        for user in users:
            if user.permissions is None:
                user.permissions = default_permissions(user.role)
                changed = True
            if not user.cloud_api_access:
                user.cloud_api_access = (
                    "full" if user.role in {Role.admin, Role.operator} else "read"
                )
                changed = True
        if changed:
            await db.commit()
    if settings.BOOTSTRAP_ADMIN_EMAIL and settings.BOOTSTRAP_ADMIN_PASSWORD:
        async with SessionFactory() as db:
            email = settings.BOOTSTRAP_ADMIN_EMAIL.lower()
            if not await db.scalar(select(User).where(User.email == email)):
                db.add(
                User(
                    username=email.split("@", 1)[0],
                    email=email,
                        full_name="CloudTool Admin",
                        password_hash=hash_password(settings.BOOTSTRAP_ADMIN_PASSWORD),
                        role=Role.admin,
                        permissions=default_permissions(Role.admin),
                        cloud_api_access="full",
                    )
                )
                await db.commit()
