"""Real PostgreSQL checks, never replaced by SQLite or an in-memory DB.

Requires TEST_DATABASE_URL ending in _test, a non-superuser/non-BYPASSRLS
owner role, and ADAMLIFE_ALLOW_TEST_DATABASE_RESET=1. Only empty public schemas
are accepted. Created objects/fixtures are removed by downgrade at completion.
"""
import os
from datetime import date, datetime, timezone
from uuid import uuid4

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, func, inspect, select, text, update
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.config import ROOT, Settings, postgres_url
from app.db import build_engine, database_ready, user_session
from app.models import Account, AuditEvent, Base, Category, Currency, PaymentOccurrence, PaymentSchedule, Transaction, User
from app.schema import SCHEMA_REVISION

pytestmark = pytest.mark.postgres


@pytest.fixture(scope="module")
def pg_engine():
    dsn = os.environ.get("TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("TEST_DATABASE_URL is not configured; real PostgreSQL tests were NOT run")
    url = postgres_url(dsn)
    if not url.database.endswith("_test") or os.environ.get("ADAMLIFE_ALLOW_TEST_DATABASE_RESET") != "1":
        pytest.fail("Use a dedicated empty *_test database and explicitly allow test reset")
    engine = create_engine(url, pool_size=1, max_overflow=0, hide_parameters=True,
                           connect_args={"connect_timeout": 3, "options": "-c timezone=UTC -c statement_timeout=5000"})
    config = Config(str(ROOT / "alembic.ini"))
    config.attributes["skip_logging"] = True
    with engine.connect() as connection:
        privileged = connection.execute(text("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")).scalar_one()
        if privileged:
            pytest.fail("RLS tests require a normal owner role, not postgres/superuser/BYPASSRLS")
        tables = set(inspect(connection).get_table_names(schema="public"))
        if tables - {"alembic_version"}:
            pytest.fail("Refusing to change a nonempty database; create a fresh *_test database")
        if "alembic_version" in tables and connection.execute(text("SELECT count(*) FROM alembic_version")).scalar_one():
            pytest.fail("Refusing to reset an already migrated database")
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
        yield engine
    finally:
        # Only the explicitly opted-in empty test database is ever downgraded.
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.downgrade(config, "base")
            assert set(inspect(connection).get_table_names(schema="public")) <= {"alembic_version"}
        engine.dispose()


@pytest.fixture
def owners(pg_engine):
    first, second = uuid4(), uuid4()
    ids = {}
    for user_id in [first, second]:
        with user_session(pg_engine, user_id) as session:
            session.add(User(id=user_id, display_name="Infrastructure test fixture"))
            session.flush()
            a, b, usd, expense, income = (uuid4() for _ in range(5))
            session.add_all([
                Account(id=a, user_id=user_id, name="Bank account A", kind="bank", bank_code="kaspi", currency="KZT",
                        opening_balance_minor=10000, opening_date=date(2026, 1, 1)),
                Account(id=b, user_id=user_id, name="Bank account B", kind="bank", bank_code="kaspi", currency="KZT",
                        opening_balance_minor=0, opening_date=date(2026, 1, 1)),
                Account(id=usd, user_id=user_id, name="USD", kind="bank", bank_code="kaspi", currency="USD",
                        opening_balance_minor=0, opening_date=date(2026, 1, 1)),
                Category(id=expense, user_id=user_id, name="Expense", kind="expense"),
                Category(id=income, user_id=user_id, name="Income", kind="income"),
            ])
            ids[user_id] = dict(a=a, b=b, usd=usd, expense=expense, income=income)
    return first, second, ids


@pytest.fixture(scope="module")
def runtime_engine(pg_engine):
    dsn = os.environ.get("TEST_RUNTIME_DATABASE_URL")
    if not dsn:
        pytest.skip("TEST_RUNTIME_DATABASE_URL is not configured for non-owner runtime tests")
    url = postgres_url(dsn)
    owner = pg_engine.url
    assert (url.host, url.port, url.database) == (owner.host, owner.port, owner.database)
    assert url.username and url.username != owner.username
    role = pg_engine.dialect.identifier_preparer.quote(url.username)
    # Grants affect only the new disposable *_test database, never development data.
    with pg_engine.begin() as connection:
        connection.execute(text("REVOKE CREATE ON SCHEMA public FROM PUBLIC"))
        for privilege, objects in [
            ("USAGE", "SCHEMA public"),
            ("SELECT", "currencies, alembic_version"),
            ("SELECT, INSERT, UPDATE", "users"),
            ("SELECT, INSERT, UPDATE, DELETE", "accounts, categories, transactions, payment_schedules, payment_occurrences, idempotency_records"),
            ("SELECT, INSERT", "audit_events"),
            ("SELECT, INSERT, UPDATE, DELETE", "login_flows, auth_sessions"),
        ]:
            connection.execute(text(f"GRANT {privilege} ON {objects} TO {role}"))
    engine = build_engine(Settings(_env_file=None, database_url=dsn, db_pool_size=1, db_max_overflow=0))
    try:
        yield engine
    finally:
        engine.dispose()


def expense_values(user_id, ids, **changes):
    values = dict(id=uuid4(), user_id=user_id, kind="expense", occurred_on=date(2026, 1, 10),
                  source_account_id=ids["a"], source_currency="KZT", source_amount_minor=100, category_id=ids["expense"])
    values.update(changes)
    return values


def test_online_upgrade_and_metadata_match(pg_engine):
    with pg_engine.connect() as connection:
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == SCHEMA_REVISION
        assert compare_metadata(MigrationContext.configure(connection, opts={"compare_type": True,
                                                                            "compare_server_default": True}), Base.metadata) == []
        rows = connection.execute(select(Currency.code, Currency.minor_unit_digits)).all()
        assert set(rows) == {("KZT", 2), ("USD", 2), ("EUR", 2)}


def test_runtime_role_readiness_and_rls_flags(runtime_engine, pg_engine):
    assert database_ready(runtime_engine)
    assert not database_ready(pg_engine)  # The migration owner must not be used by the API.
    with runtime_engine.connect() as connection:
        assert connection.execute(text("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user")).scalar_one() is False
        protected = connection.execute(text("""
            SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
            WHERE relnamespace = 'public'::regnamespace AND relname IN
              ('users','accounts','categories','transactions','payment_schedules','payment_occurrences','audit_events','idempotency_records')
        """)).all()
        assert len(protected) == 8
        assert all(enabled and forced for _, enabled, forced in protected)


def test_runtime_isolation_and_rollback_reset(runtime_engine, owners):
    first, second, ids = owners
    for user_id in [first, second]:
        with user_session(runtime_engine, user_id) as session:
            assert set(session.scalars(select(Account.id))) == {ids[user_id][key] for key in ["a", "b", "usd"]}
    with pytest.raises(RuntimeError, match="test rollback"):
        with user_session(runtime_engine, first) as session:
            session.execute(update(Account).where(Account.id == ids[first]["a"]).values(opening_balance_minor=99999, version=2))
            raise RuntimeError("test rollback")
    with runtime_engine.connect() as connection:
        assert connection.execute(select(func.count()).select_from(Account)).scalar_one() == 0
        assert connection.execute(text("SELECT nullif(current_setting('app.user_id',true),'')")).scalar_one() is None
    with user_session(runtime_engine, first) as session:
        assert session.get(Account, ids[first]["a"]).opening_balance_minor == 10000
        assert session.scalar(select(func.count()).select_from(AuditEvent)) == 0


def test_runtime_can_audit_baseline_but_cannot_tamper_with_audit(runtime_engine, owners):
    first, _, ids = owners
    with user_session(runtime_engine, first) as session:
        session.execute(update(Account).where(Account.id == ids[first]["a"]).values(opening_balance_minor=11000, version=2))
    with user_session(runtime_engine, first) as session:
        assert session.scalar(select(func.count()).select_from(AuditEvent)) == 1
    with pytest.raises(DBAPIError) as error:
        with user_session(runtime_engine, first) as session:
            session.execute(update(AuditEvent).values(action="tamper"))
    assert error.value.orig.sqlstate == "42501"


def test_rls_no_context_denies_reads_and_writes(pg_engine, owners):
    first, _, ids = owners
    with pg_engine.connect() as connection:
        assert connection.execute(select(func.count()).select_from(Account)).scalar_one() == 0
        with pytest.raises(DBAPIError) as error:
            connection.execute(Account.__table__.insert().values(
                id=uuid4(), user_id=first, name="Not allowed", kind="cash", currency="KZT",
                opening_date=date(2026, 1, 1), opening_balance_minor=0))
        assert error.value.orig.sqlstate == "42501"


def test_owner_isolation_and_pooled_context_reset(pg_engine, owners):
    first, second, ids = owners
    for user_id in [first, second]:
        with user_session(pg_engine, user_id) as session:
            accounts = session.scalars(select(Account)).all()
            assert {a.id for a in accounts} == {ids[user_id]["a"], ids[user_id]["b"], ids[user_id]["usd"]}
            assert all(a.user_id == user_id for a in accounts)
    with pg_engine.connect() as connection:
        assert connection.execute(text("SELECT nullif(current_setting('app.user_id', true), '')")).scalar_one() is None
        assert connection.execute(select(func.count()).select_from(Account)).scalar_one() == 0


def test_cross_owner_reference_is_rejected(pg_engine, owners):
    first, second, ids = owners
    with pytest.raises(IntegrityError):
        with user_session(pg_engine, first) as session:
            session.add(Transaction(**expense_values(first, ids[first], source_account_id=ids[second]["a"])))


def test_multiple_accounts_same_bank_and_precise_bigint_persist(pg_engine, owners):
    first, _, ids = owners
    amount = 9_007_199_254_740_993
    values = expense_values(first, ids[first], source_amount_minor=amount)
    with user_session(pg_engine, first) as session:
        session.add(Transaction(**values))
    with user_session(pg_engine, first) as session:
        assert session.get(Transaction, values["id"]).source_amount_minor == amount
        assert session.scalar(select(func.count()).select_from(Account).where(Account.bank_code == "kaspi")) == 3


@pytest.mark.parametrize("changes", [
    {"source_amount_minor": 0}, {"source_amount_minor": -1}, {"source_currency": "USD"},
    {"category_id": None}, {"source_amount_minor": None}, {"occurred_on": date(2025, 12, 31)},
])
def test_invalid_financial_rows_are_rejected_by_schema(pg_engine, owners, changes):
    first, _, ids = owners
    with pytest.raises(IntegrityError):
        with user_session(pg_engine, first) as session:
            session.add(Transaction(**expense_values(first, ids[first], **changes)))


@pytest.mark.parametrize("same_account,amount", [(True, 100), (False, 101)])
def test_invalid_transfers_are_rejected(pg_engine, owners, same_account, amount):
    first, _, ids = owners
    with pytest.raises(IntegrityError):
        with user_session(pg_engine, first) as session:
            session.add(Transaction(id=uuid4(), user_id=first, kind="transfer", occurred_on=date(2026, 1, 2),
                                    source_account_id=ids[first]["a"], source_currency="KZT", source_amount_minor=100,
                                    destination_account_id=ids[first]["a" if same_account else "b"],
                                    destination_currency="KZT", destination_amount_minor=amount))


def test_explicit_fx_transfer_keeps_two_distinct_currency_amounts(pg_engine, owners):
    first, _, ids = owners
    transaction_id = uuid4()
    with user_session(pg_engine, first) as session:
        session.add(Transaction(id=transaction_id, user_id=first, kind="transfer", occurred_on=date(2026, 1, 2),
                                source_account_id=ids[first]["a"], source_currency="KZT", source_amount_minor=50000,
                                destination_account_id=ids[first]["usd"], destination_currency="USD", destination_amount_minor=100))
    with user_session(pg_engine, first) as session:
        row = session.get(Transaction, transaction_id)
        assert (row.source_currency, row.source_amount_minor) == ("KZT", 50000)
        assert (row.destination_currency, row.destination_amount_minor) == ("USD", 100)


def test_baseline_edit_is_versioned_and_audited_atomically(pg_engine, owners):
    first, _, ids = owners
    with pytest.raises(IntegrityError):
        with user_session(pg_engine, first) as session:
            session.execute(update(Account).where(Account.id == ids[first]["a"]).values(opening_balance_minor=12000))
    with user_session(pg_engine, first) as session:
        assert session.scalar(select(func.count()).select_from(AuditEvent)) == 0
        session.execute(update(Account).where(Account.id == ids[first]["a"]).values(
            opening_balance_minor=12000, opening_date=date(2025, 12, 1), version=2))
    with user_session(pg_engine, first) as session:
        account = session.get(Account, ids[first]["a"])
        event = session.scalars(select(AuditEvent)).one()
        assert account.version == 2 and account.opening_balance_minor == 12000
        assert event.changes["old"]["opening_balance_minor"] == "10000"
        assert event.changes["new"]["opening_balance_minor"] == "12000"
        # RLS denies UPDATE/DELETE on the append-only audit table.
        assert session.execute(update(AuditEvent).values(action="tamper")).rowcount == 0
        session.add(Transaction(**expense_values(first, ids[first], occurred_on=date(2025, 12, 15))))


def test_cutoff_cannot_silently_exclude_recorded_history(pg_engine, owners):
    first, _, ids = owners
    with user_session(pg_engine, first) as session:
        session.add(Transaction(**expense_values(first, ids[first])))
    with pytest.raises(IntegrityError):
        with user_session(pg_engine, first) as session:
            session.execute(update(Account).where(Account.id == ids[first]["a"]).values(
                opening_date=date(2026, 2, 1), version=2))


def test_currency_is_immutable(pg_engine, owners):
    first, _, ids = owners
    with pytest.raises(IntegrityError):
        with user_session(pg_engine, first) as session:
            session.execute(update(Account).where(Account.id == ids[first]["a"]).values(currency="EUR"))


def test_referenced_account_cannot_be_deleted(pg_engine, owners):
    first, _, ids = owners
    with user_session(pg_engine, first) as session:
        session.add(Transaction(**expense_values(first, ids[first])))
    with pytest.raises(IntegrityError):
        with user_session(pg_engine, first) as session:
            session.delete(session.get(Account, ids[first]["a"]))


def test_payment_links_exact_expense_once(pg_engine, owners):
    first, _, ids = owners
    schedule_id, transaction_id, occurrence_id = uuid4(), uuid4(), uuid4()
    with user_session(pg_engine, first) as session:
        session.add(Transaction(**expense_values(first, ids[first], id=transaction_id)))
        session.add(PaymentSchedule(id=schedule_id, user_id=first, title="Monthly fixture", account_id=ids[first]["a"],
                                    currency="KZT", amount_minor=100, frequency="monthly", starts_on=date(2026, 1, 1), day_of_month=10))
        session.flush()
        session.add(PaymentOccurrence(id=occurrence_id, user_id=first, schedule_id=schedule_id, period_start=date(2026, 1, 1),
                                     due_on=date(2026, 1, 10), title="Snapshot", account_id=ids[first]["a"], currency="KZT",
                                     amount_minor=100, paid_at=datetime.now(timezone.utc), transaction_id=transaction_id))
    with pytest.raises(IntegrityError):
        with user_session(pg_engine, first) as session:
            session.add(PaymentOccurrence(id=uuid4(), user_id=first, schedule_id=schedule_id, period_start=date(2026, 2, 1),
                                         due_on=date(2026, 2, 10), title="Duplicate payment", account_id=ids[first]["a"], currency="KZT",
                                         amount_minor=100, paid_at=datetime.now(timezone.utc), transaction_id=transaction_id))
