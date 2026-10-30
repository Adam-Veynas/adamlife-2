from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

from app.config import Settings
from app.models import Base
import app.auth_models  # Register authentication metadata for Alembic drift checks.

config = context.config
if config.config_file_name and not config.attributes.get("skip_logging"):
    fileConfig(config.config_file_name)


def run_migrations_offline() -> None:
    # No credentials or server needed to generate PostgreSQL SQL.
    context.configure(dialect_name="postgresql", target_metadata=Base.metadata,
                      literal_binds=True, dialect_opts={"paramstyle": "named"}, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    supplied_connection = config.attributes.get("connection")
    if supplied_connection is not None:
        context.configure(connection=supplied_connection, target_metadata=Base.metadata,
                          compare_type=True, compare_server_default=True)
        with context.begin_transaction():
            context.run_migrations()
        return
    settings = Settings()
    engine = create_engine(settings.migration_url(), poolclass=pool.NullPool, hide_parameters=True,
                           connect_args={"connect_timeout": settings.db_connect_timeout})
    try:
        with engine.connect() as connection:
            context.configure(connection=connection, target_metadata=Base.metadata,
                              compare_type=True, compare_server_default=True)
            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
