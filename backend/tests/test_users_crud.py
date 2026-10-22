from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routers.users import create_user, delete_user, update_user
from app.core.permissions import default_permissions
from app.core.security import hash_password
from app.db.base import Base
from app.models import Role, User
from app.schemas.common import UserIn, UserPatch


async def test_local_user_crud_and_permission_updates():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    # Production SQLite attaches an operational telemetry database.  SQLAlchemy
    # models retain that schema name, so mirror it for this in-memory test.
    @event.listens_for(engine.sync_engine, "connect")
    def attach_telemetry(connection, _record):
        connection.execute("ATTACH DATABASE ':memory:' AS telemetry")

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as db:
        admin = User(
            email="admin@example.com",
            username="admin",
            full_name="Admin",
            password_hash=hash_password("AdminPassword!123"),
            role=Role.admin,
            is_active=True,
            permissions=default_permissions(Role.admin),
            cloud_api_access="full",
        )
        db.add(admin)
        await db.commit()

        created = await create_user(
            UserIn(
                email="operator@example.com",
                username="operator",
                full_name="Operator",
                password="OperatorPassword!123",
                role="operator",
                permissions=["servers"],
                cloud_api_access="read",
            ),
            admin,
            None,
            db,
        )
        assert created.permissions == ["servers"]
        assert created.cloud_api_access == "read"

        updated = await update_user(
            created.id,
            UserPatch(
                permissions=["servers", "private_ips"],
                cloud_api_access="full",
            ),
            admin,
            None,
            db,
        )
        assert updated.permissions == ["private_ips", "servers"]
        assert updated.cloud_api_access == "full"

        await delete_user(created.id, admin, None, db)
        assert await db.get(User, created.id) is None
    await engine.dispose()
