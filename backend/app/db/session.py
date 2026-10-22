from pathlib import Path

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings

settings = get_settings()
settings.ensure_data_directory()
engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)


def _sqlite_path(database_url: str) -> str:
    raw = database_url.split("///", 1)[1]
    return str((Path(__file__).resolve().parents[2] / raw).resolve())

if settings.DATABASE_URL.startswith("sqlite"):

    @event.listens_for(engine.sync_engine, "connect")
    def configure_sqlite(connection, _record) -> None:
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        if settings.TELEMETRY_DATABASE_URL.startswith("sqlite"):
            cursor.execute("ATTACH DATABASE ? AS telemetry", (_sqlite_path(settings.TELEMETRY_DATABASE_URL),))
            cursor.execute("PRAGMA telemetry.journal_mode=WAL")
            cursor.execute("PRAGMA telemetry.busy_timeout=5000")
        cursor.close()


SessionFactory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    async with SessionFactory() as session:
        yield session
