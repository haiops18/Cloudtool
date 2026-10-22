"""Remove obsolete Share monitor storage and user permissions."""

import sqlalchemy as sa


def remove_share_monitor(connection) -> None:
    inspector = sa.inspect(connection)
    if inspector.has_table("monitor_projects"):
        sa.Table("monitor_projects", sa.MetaData()).drop(connection)
    if not inspector.has_table("users"):
        return
    users = sa.Table("users", sa.MetaData(), autoload_with=connection)
    if "permissions" not in users.c:
        return
    for user_id, permissions in connection.execute(sa.select(users.c.id, users.c.permissions)):
        if isinstance(permissions, list) and "share_monitor" in permissions:
            connection.execute(
                users.update().where(users.c.id == user_id).values(
                    permissions=[item for item in permissions if item != "share_monitor"]
                )
            )
