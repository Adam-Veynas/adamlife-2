from io import StringIO
import importlib.util

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import BigInteger, CheckConstraint, Float, ForeignKeyConstraint, Index, MetaData, Table, UniqueConstraint
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable

from app.config import ROOT
from app.models import Base
from app.schema import SCHEMA_REVISION


def migration_config(buffer=None):
    config = Config(str(ROOT / "alembic.ini"), output_buffer=buffer)
    config.attributes["skip_logging"] = True
    return config


def upgrade_sql():
    buffer = StringIO()
    command.upgrade(migration_config(buffer), "head", sql=True)
    return buffer.getvalue()


def test_one_linear_revision_chain():
    scripts = ScriptDirectory.from_config(migration_config())
    assert scripts.get_heads() == [SCHEMA_REVISION]
    assert len(list(scripts.walk_revisions())) == 3


def test_migrations_generate_complete_postgresql_sql_without_connection():
    sql = upgrade_sql()
    assert sql.startswith("BEGIN;") and sql.rstrip().endswith("COMMIT;")
    assert set(Base.metadata.tables) == {"users", "currencies", "accounts", "categories", "transactions",
                                         "payment_schedules", "payment_occurrences", "audit_events", "idempotency_records",
                                         "login_flows", "auth_sessions"}
    for table in Base.metadata.sorted_tables:
        assert f"CREATE TABLE {table.name}" in sql
        assert str(CreateTable(table).compile(dialect=postgresql.dialect()))
        for column in table.columns:
            assert column.name in sql
    assert "BIGINT" in sql and "TIMESTAMP WITH TIME ZONE" in sql and "JSONB" in sql
    for currency in ["KZT", "USD", "EUR"]:
        assert f"VALUES ('{currency}', 2)" in sql
    assert "INSERT INTO users" not in sql and "INSERT INTO accounts" not in sql


def test_downgrade_generates_reverse_order_without_connection():
    buffer = StringIO()
    command.downgrade(migration_config(buffer), "head:base", sql=True)
    sql = buffer.getvalue()
    assert sql.index("DROP TABLE payment_occurrences") < sql.index("DROP TABLE transactions") < sql.index("DROP TABLE accounts")
    assert "DROP FUNCTION guard_account_baseline()" in sql
    assert "DELETE FROM alembic_version" in sql


@pytest.mark.parametrize("table", ["users", "accounts", "categories", "transactions", "payment_schedules",
                                    "payment_occurrences", "audit_events", "idempotency_records"])
def test_rls_is_forced_and_fails_closed(table):
    sql = upgrade_sql()
    assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY" in sql
    assert f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY" in sql
    assert "nullif(current_setting('app.user_id', true), '')::uuid" in sql
    if table == "audit_events":
        assert "ON audit_events FOR SELECT" in sql and "ON audit_events FOR INSERT" in sql
        assert "ON audit_events FOR UPDATE" not in sql


def test_money_uses_integer_minor_units_only():
    for table in Base.metadata.tables.values():
        for column in table.columns:
            assert not isinstance(column.type, Float)
            if column.name.endswith("_minor"):
                assert isinstance(column.type, BigInteger)
    assert "balance" not in Base.metadata.tables["accounts"].columns
    assert "current_balance_minor" not in Base.metadata.tables["accounts"].columns


def test_multiple_accounts_of_same_bank_are_allowed():
    for constraint in Base.metadata.tables["accounts"].constraints:
        if isinstance(constraint, UniqueConstraint):
            assert "bank_code" not in constraint.columns


def test_cross_entity_foreign_keys_include_owner():
    for table in Base.metadata.tables.values():
        for constraint in table.constraints:
            if isinstance(constraint, ForeignKeyConstraint):
                target = constraint.elements[0].column.table.name
                if target not in {"users", "currencies"}:
                    assert "user_id" in constraint.columns


def test_opening_boundary_audit_and_transfer_constraints_are_in_sql():
    sql = upgrade_sql()
    assert sql.count("END; $$;") == 3
    for fragment in ["NEW.occurred_on < account_row.opening_date", "FOR SHARE", "OLD.version + 1",
                     "occurred_on < NEW.opening_date", "'opening_changed'", "OLD.opening_balance_minor::text",
                     "Audit events are append-only", "ck_transactions_different_accounts",
                     "ck_transactions_same_currency_transfer", "fk_payment_occurrences_expense"]:
        assert fragment in sql


def test_frozen_migrations_do_not_import_live_models():
    for file in (ROOT / "migrations" / "versions").glob("*.py"):
        source = file.read_text(encoding="utf-8")
        assert "app.models" not in source and "Base.metadata" not in source


def test_frozen_initial_migration_matches_all_orm_tables(monkeypatch):
    """Compare real SQLAlchemy objects built from frozen migration vs current models.

    This catches drift without pretending to execute PostgreSQL's constraints.
    Online tests additionally compare against a real database.
    """
    recorded = MetaData()

    class Recorder:
        @staticmethod
        def f(name):
            return name

        @staticmethod
        def create_table(name, *items, **kwargs):
            return Table(name, recorded, *items, **kwargs)

        @staticmethod
        def create_index(name, table, columns, unique=False):
            return Index(name, *(recorded.tables[table].c[c] for c in columns), unique=unique)

        @staticmethod
        def bulk_insert(*args):
            pass

    spec = importlib.util.spec_from_file_location("frozen_foundation", ROOT / "migrations/versions/0001_foundation.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "op", Recorder)
    module.upgrade()

    def columns(table):
        return [(c.name, str(c.type.compile(dialect=postgresql.dialect())), c.nullable,
                 str(c.server_default.arg) if c.server_default is not None else None) for c in table.columns]

    def constraints(table):
        result = set()
        for c in table.constraints:
            definition = tuple(col.name for col in c.columns)
            if isinstance(c, CheckConstraint):
                definition = (" ".join(str(c.sqltext).split()),)
            if isinstance(c, ForeignKeyConstraint):
                definition += tuple(e.target_fullname for e in c.elements) + (c.ondelete,)
            result.add((type(c).__name__, str(c.name), definition))
        return result

    assert set(recorded.tables) == set(Base.metadata.tables) - {"auth_sessions", "login_flows"}
    for name in recorded.tables:
        expected = Base.metadata.tables[name]
        assert columns(recorded.tables[name]) == columns(expected)
        assert constraints(recorded.tables[name]) == constraints(expected)
        indexes = lambda t: {(i.name, tuple(c.name for c in i.columns), i.unique) for i in t.indexes}
        assert indexes(recorded.tables[name]) == indexes(expected)


def test_env_example_contains_no_usable_credentials():
    text = (ROOT / ".env.example").read_text(encoding="utf-8")
    assert ":CHANGE_ME@" in text
    assert "DATABASE_URL=" in text and "MIGRATION_DATABASE_URL=" in text
