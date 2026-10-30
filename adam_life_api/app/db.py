from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session

from app.config import Settings
from app.schema import SCHEMA_REVISION


def build_engine(settings: Settings) -> Engine:
    return create_engine(
        settings.runtime_url(),
        pool_pre_ping=True,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_timeout=settings.db_pool_timeout,
        hide_parameters=True,
        connect_args={
            "connect_timeout": settings.db_connect_timeout,
            "options": f"-c statement_timeout={settings.db_statement_timeout_ms} -c timezone=UTC",
        },
    )


@contextmanager
def user_session(engine: Engine, user_id: UUID) -> Iterator[Session]:
    """Internal primitive, NOT authentication. Only a verified server identity may call it.

    SET LOCAL is limited to this transaction, including with pooled connections.
    Do not commit or change user inside the block. No HTTP endpoint accepts user_id.
    """
    if not isinstance(user_id, UUID):
        raise ValueError("A verified UUID identity is required")
    with Session(engine, expire_on_commit=False) as session:
        with session.begin():
            session.execute(text("SELECT set_config('app.user_id', :user_id, true)"), {"user_id": str(user_id)})
            yield session


def database_ready(engine: Engine | None) -> bool:
    if engine is None:
        return False
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
        # The API must not connect as a role able to bypass row-level security.
        safe_role = connection.execute(text("""
            SELECT NOT (rolsuper OR rolbypassrls)
              AND NOT EXISTS (
                SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname IN ('accounts', 'transactions')
                  AND pg_has_role(current_user, c.relowner, 'MEMBER')
              )
            FROM pg_roles WHERE rolname = current_user
        """)).scalar_one()
        revision = connection.execute(text("SELECT version_num FROM alembic_version")).scalars().all()
        return bool(safe_role) and revision == [SCHEMA_REVISION]
