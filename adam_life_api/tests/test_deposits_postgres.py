"""Deposit metadata uses the existing account API and transfer ledger."""
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import select, text

from app.db import user_session
from app.models import Account, AuditEvent
from test_finance_postgres import clients, pg_engine, runtime_engine

pytestmark = pytest.mark.postgres


def payload(account):
    return {key: value for key, value in account.items() if key not in {"id", "version", "balance_minor"}}


def test_metadata_edit_archive_clear_and_isolation(clients, runtime_engine):
    c, stranger = clients(), clients()
    base = dict(name="Депозит", kind="deposit", bank_code="same_bank", currency="KZT",
                opening_date="2026-01-01", opening_balance_minor="1000", deposit_type="term",
                annual_rate="15.1234", deposit_opened_on="2024-01-01", deposit_ends_on="2027-01-01")
    first = c.request("POST", "/accounts", base)
    assert first.status_code == 201, first.text
    a = first.json()
    assert c.request("POST", "/accounts", base).status_code == 201  # same bank, same name allowed
    assert stranger.request("PUT", "/accounts/" + a["id"], {**base, "expected_version": 1}).status_code == 404
    assert stranger.snapshot()["accounts"] == []
    edit = {**base, "annual_rate": "0", "deposit_type": "savings", "deposit_ends_on": None, "expected_version": 1}
    r = c.request("PUT", "/accounts/" + a["id"], edit)
    assert r.status_code == 200, r.text
    assert r.json()["deposit_ends_on"] is None
    # Old clients/archive omit the new fields. Do not erase stored metadata.
    old = {k: v for k, v in base.items() if k not in {"deposit_type", "annual_rate", "deposit_opened_on", "deposit_ends_on"}}
    r = c.request("PUT", "/accounts/" + a["id"], {**old, "archived": True, "expected_version": 2})
    assert r.status_code == 200
    assert r.json()["deposit_type"] == "savings" and r.json()["annual_rate"] == "0.0000"
    assert r.json()["deposit_opened_on"] == "2024-01-01"
    assert c.snapshot()["balances"]["KZT"]["deposit_minor"] == "2000"
    with user_session(runtime_engine, c.uid) as session:
        changes = list(session.scalars(select(AuditEvent).where(AuditEvent.entity_id == a["id"], AuditEvent.action == "updated")))
        assert any(e.changes["after"]["annual_rate"] == "0" for e in changes)
        assert not list(session.scalars(select(AuditEvent).where(AuditEvent.entity_id == a["id"], AuditEvent.action == "opening_changed")))
    # Switching back to a regular account clears deposit-only metadata.
    r = c.request("PUT", "/accounts/" + a["id"], {**old, "kind": "bank", "expected_version": 3})
    assert r.status_code == 200 and r.json()["deposit_type"] is None and r.json()["annual_rate"] is None


@pytest.mark.parametrize("fields", [
    {"deposit_type": None}, {"deposit_type": "unknown"}, {"annual_rate": "-1"},
    {"annual_rate": "NaN"}, {"annual_rate": "Infinity"}, {"annual_rate": "12.12345"},
    {"annual_rate": "100000"}, {"deposit_opened_on": "2026-02-01", "deposit_ends_on": "2026-01-01"},
])
def test_invalid_deposit_fields(clients, fields):
    c = clients()
    body = dict(name="Депозит", kind="deposit", currency="KZT", opening_date="2026-01-01",
                opening_balance_minor="0", deposit_type="term", **{})
    assert c.request("POST", "/accounts", {**body, **fields}).status_code == 422
    assert c.snapshot()["accounts"] == []


def test_old_client_preserves_unknown_legacy_type(clients, runtime_engine):
    c = clients()
    a = c.account(kind="deposit")
    with user_session(runtime_engine, c.uid) as session:
        session.get(Account, a["id"]).deposit_type = None
    old = {k: v for k, v in payload(a).items() if k not in {"deposit_type", "annual_rate", "deposit_opened_on", "deposit_ends_on"}}
    r = c.request("PUT", "/accounts/" + a["id"], {**old, "archived": True, "expected_version": 1})
    assert r.status_code == 200 and r.json()["deposit_type"] is None


def test_optional_metadata_and_transfers_both_ways(clients):
    c = clients()
    card = c.account(opening="10000000")
    term = c.request("POST", "/accounts", dict(name="Срочный", kind="deposit", currency="KZT", opening_date="2026-01-01", opening_balance_minor="0", deposit_type="term")).json()
    c.operation(card, "transfer", "10000000", term)
    c.operation(term, "transfer", "3000000", card)
    c.http._transport.app.state.engine.dispose()
    result = c.snapshot()
    assert len(result["operations"]) == 2 and all(op["kind"] == "transfer" for op in result["operations"])
    assert result["balances"]["KZT"] == dict(total_minor="10000000", current_minor="3000000", deposit_minor="7000000")
    assert next(a for a in result["accounts"] if a["id"] == term["id"])["deposit_type"] == "term"


def test_upgrade_preserves_legacy_deposit(pg_engine):
    # Dedicated test DB only. Roll back all DDL and fixture data on exit.
    with pg_engine.connect() as conn:
        tx = conn.begin()
        try:
            config = Config("alembic.ini")
            config.attributes.update(connection=conn, skip_logging=True)
            command.downgrade(config, "0004_finance")
            uid, aid = uuid4(), uuid4()
            conn.execute(text("SELECT set_config('app.user_id', :uid, true)"), {"uid": str(uid)})
            conn.execute(text("INSERT INTO users (id,display_name) VALUES (:id,'Legacy migration test')"), {"id": uid})
            conn.execute(text("INSERT INTO accounts (id,user_id,name,kind,currency,opening_balance_minor,opening_date) VALUES (:id,:uid,'Legacy','deposit','KZT',12345,'2020-01-01')"), {"id": aid, "uid": uid})
            command.upgrade(config, "0005_deposit")
            row = conn.execute(text("SELECT opening_balance_minor,deposit_type,annual_rate,deposit_opened_on,deposit_ends_on FROM accounts WHERE id=:id"), {"id": aid}).one()
            assert tuple(row) == (12345, None, None, None, None)
        finally:
            tx.rollback()
