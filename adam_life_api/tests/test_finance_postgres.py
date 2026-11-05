"""Financial API against actual PostgreSQL, authenticated sessions and forced RLS."""
import asyncio
from datetime import timedelta
import secrets
from uuid import uuid4

import httpx
import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import select, text

from app.auth import csrf_token, digest, now
from app.auth_models import AuthSession
from app.config import Settings
from app.db import user_session
from app.main import create_app
from app.models import Account, AuditEvent, Base, User
from test_postgres import pg_engine, runtime_engine

ORIGIN = "https://app.example.test"
pytestmark = pytest.mark.postgres


@pytest.fixture
def clients(runtime_engine):
    settings = Settings(_env_file=None, app_env="test", frontend_origin=ORIGIN,
                        google_redirect_uri=ORIGIN + "/api/auth/google/callback",
                        trusted_hosts=["app.example.test"], cors_origins=[ORIGIN])
    app = create_app(settings)
    app.state.engine = runtime_engine
    created = []
    with asyncio.Runner() as runner:
        class Client:
            def __init__(self):
                self.uid, self.raw = uuid4(), secrets.token_urlsafe(32)
                with user_session(runtime_engine, self.uid) as session:
                    session.add(User(id=self.uid, display_name="Finance test"))
                    session.flush()
                    session.execute(text("SELECT set_config('app.session_hash', :hash, true)"), {"hash": digest(self.raw)})
                    session.add(AuthSession(user_id=self.uid, token_hash=digest(self.raw), expires_at=now() + timedelta(days=1)))
                self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN,
                    cookies={settings.session_cookie: self.raw})
                self.request("POST", "/bootstrap", {}).raise_for_status()

            def request(self, method, path, body=None, headers=None):
                return runner.run(self.http.request(method, "/finance" + path, json=body,
                    headers=headers if headers is not None else {"Origin": ORIGIN, "X-CSRF-Token": csrf_token(self.raw)}))

            def snapshot(self):
                response = self.request("GET", "/snapshot")
                assert response.status_code == 200, response.text
                return response.json()

            def account(self, name="Карта", kind="bank", currency="KZT", opening="10000000"):
                response = self.request("POST", "/accounts", dict(name=name, kind=kind, bank_code="same_bank",
                    currency=currency, opening_date="2026-01-01", opening_balance_minor=opening))
                assert response.status_code == 201, response.text
                return response.json()

            def operation(self, account, kind="expense", amount="101", destination=None, **changes):
                category = next((c["id"] for c in self.snapshot()["categories"] if c["kind"] == kind), None)
                body = dict(kind=kind, occurred_on="2026-02-01", account_id=account["id"],
                            destination_account_id=destination["id"] if destination else None,
                            amount_minor=amount, category_id=category)
                body.update(changes)
                response = self.request("POST", "/operations", body)
                assert response.status_code == 201, response.text
                return response.json(), body

        def factory():
            client = Client()
            created.append(client)
            return client

        yield factory
        for client in created:
            runner.run(client.http.aclose())
            # Only this fixture's rows in the disposable *_test DB. The guarded
            # migration downgrade refuses to lose deposits in any real database.
            with user_session(runtime_engine, client.uid) as session:
                for row in session.scalars(select(Account).where(Account.kind == "deposit")):
                    row.kind = "bank"


def test_online_finance_migration(pg_engine):
    with pg_engine.connect() as connection:
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0004_finance"
        assert compare_metadata(MigrationContext.configure(connection, opts={"compare_type": True, "compare_server_default": True}), Base.metadata) == []


def test_income_expense_transfer_edit_delete_and_persistence(clients):
    client = clients()
    a, b = client.account(), client.account("Депозит", "deposit", opening="0")
    usd = client.account("USD", currency="USD", opening="12345")
    income, _ = client.operation(a, "income", "123456")
    expense, _ = client.operation(a, "expense", "10001")
    transfer, body = client.operation(a, "transfer", "10000000", b)
    result = client.snapshot()
    assert len(result["operations"]) == 3
    amounts = {r["id"]: r["balance_minor"] for r in result["accounts"]}
    assert amounts == {a["id"]: "113455", b["id"]: "10000000", usd["id"]: "12345"}
    assert result["balances"]["KZT"]["total_minor"] == "10113455"
    assert result["balances"]["USD"]["total_minor"] == "12345"
    changed = client.request("PUT", "/operations/" + transfer["id"], {**body, "amount_minor": "5000000", "expected_version": 1})
    assert changed.status_code == 200
    result = client.snapshot()
    assert result["balances"]["KZT"] == dict(total_minor="10113455", current_minor="5113455", deposit_minor="5000000")
    assert client.request("PUT", "/operations/" + transfer["id"], {**body, "expected_version": 1}).status_code == 409
    assert client.request("DELETE", "/operations/" + transfer["id"], {"expected_version": 2}).status_code == 200
    assert client.snapshot()["balances"]["KZT"]["deposit_minor"] == "0"
    assert client.request("DELETE", "/operations/" + expense["id"], {"expected_version": 1}).status_code == 200
    assert client.snapshot()["balances"]["KZT"]["total_minor"] == "10123456"
    # Dispose connections: a new DB connection reads committed data, not local state.
    client.http._transport.app.state.engine.dispose()
    assert client.snapshot()["balances"]["KZT"]["total_minor"] == "10123456"


def test_future_entries_do_not_change_current_balance(clients):
    c = clients()
    a = c.account(opening="1000")
    c.operation(a, amount="100", occurred_on="9999-01-01")
    response = c.request("POST", "/accounts", dict(name="Будущий счёт", kind="bank", currency="KZT", opening_date="9999-01-01", opening_balance_minor="123"))
    assert response.status_code == 201
    snapshot = c.snapshot()
    assert snapshot["balances"]["KZT"]["total_minor"] == "1000"
    assert len(snapshot["operations"]) == 1  # still visible in history
    assert snapshot["accounts"][1]["balance_minor"] == "0"


def test_transfer_reassignment_and_operation_kind_changes(clients):
    c = clients()
    a, b, d = c.account(opening="1000"), c.account(opening="0"), c.account(kind="deposit", opening="0")
    op, body = c.operation(a, "transfer", "100", b)
    changed = {**body, "account_id": b["id"], "destination_account_id": d["id"], "expected_version": 1}
    assert c.request("PUT", "/operations/" + op["id"], changed).status_code == 200
    assert {r["id"]: r["balance_minor"] for r in c.snapshot()["accounts"]} == {a["id"]: "1000", b["id"]: "-100", d["id"]: "100"}
    income_category = next(r["id"] for r in c.snapshot()["categories"] if r["kind"] == "income")
    income = {**body, "kind": "income", "destination_account_id": None, "category_id": income_category, "expected_version": 2}
    assert c.request("PUT", "/operations/" + op["id"], income).status_code == 200
    assert c.snapshot()["balances"]["KZT"]["total_minor"] == "1100"
    expense_category = next(r["id"] for r in c.snapshot()["categories"] if r["kind"] == "expense")
    assert c.request("PUT", "/operations/" + op["id"], {**income, "kind": "expense", "category_id": expense_category, "expected_version": 3}).status_code == 200
    assert c.snapshot()["balances"]["KZT"]["total_minor"] == "900"
    assert c.request("DELETE", "/operations/" + op["id"], {"expected_version": 4}).status_code == 200
    assert c.snapshot()["balances"]["KZT"]["total_minor"] == "1000"
    assert c.request("DELETE", "/accounts/" + a["id"], {"expected_version": 1}).status_code == 409


def test_tenant_isolation_and_csrf(clients):
    a, b = clients(), clients()
    own, other = a.account(), b.account()
    operation, body = b.operation(other)
    assert len(a.snapshot()["accounts"]) == 1
    assert a.snapshot()["operations"] == []
    assert not ({c["id"] for c in a.snapshot()["categories"]} & {c["id"] for c in b.snapshot()["categories"]})
    assert a.request("PUT", "/accounts/" + other["id"], {k: v for k, v in {**other, "expected_version": 1}.items() if k not in {"id", "version", "balance_minor"}}).status_code == 404
    assert a.request("DELETE", "/operations/" + operation["id"], {"expected_version": 1}).status_code == 404
    assert a.request("POST", "/operations", body).status_code == 404
    own_body = {**body, "account_id": own["id"]}
    assert a.request("POST", "/operations", own_body).status_code == 404  # foreign category
    assert a.request("POST", "/bootstrap", {}, headers={"Origin": "https://evil.test"}).status_code == 403
    assert a.request("POST", "/bootstrap", {}, headers={"Origin": ORIGIN}).status_code == 403
    assert a.request("POST", "/bootstrap", {"user_id": str(b.uid)}).status_code == 200  # body unused, cannot select another user
    a.http.cookies.clear()
    assert a.request("GET", "/snapshot").status_code == 401


def test_baseline_audit_boundary_and_safe_deletion(clients, runtime_engine):
    c = clients()
    account = c.account()
    op, body = c.operation(account)
    edit = {k: v for k, v in account.items() if k not in {"id", "version", "balance_minor"}}
    edit.update(opening_balance_minor="123", expected_version=1)
    assert c.request("PUT", "/accounts/" + account["id"], edit).status_code == 422
    edit["opening_change_reason"] = "Исправлена исходная сумма"
    assert c.request("PUT", "/accounts/" + account["id"], edit).status_code == 200
    assert c.snapshot()["accounts"][0]["balance_minor"] == "22"
    with user_session(runtime_engine, c.uid) as session:
        events = list(session.scalars(select(AuditEvent).where(AuditEvent.action == "opening_changed")))
        assert len(events) == 1
        assert events[0].changes["old"]["opening_balance_minor"] == "10000000"
        assert events[0].changes["new"]["opening_balance_minor"] == "123"
    assert c.request("PUT", "/accounts/" + account["id"], {**edit, "expected_version": 2, "opening_date": "2026-03-01"}).status_code == 409
    assert c.request("POST", "/operations", {**body, "occurred_on": "2025-12-31"}).status_code == 422
    assert c.request("DELETE", "/accounts/" + account["id"], {"expected_version": 2}).status_code == 409
    assert c.request("PUT", "/accounts/" + account["id"], {**edit, "expected_version": 2, "archived": True}).status_code == 200
    assert c.snapshot()["balances"]["KZT"]["total_minor"] == "22"
    assert c.request("POST", "/operations", body).status_code == 409
    unused = c.account(opening="150")
    assert c.request("DELETE", "/accounts/" + unused["id"], {"expected_version": 1}).status_code == 200


def test_categories_bootstrap_archive_and_delete(clients):
    c = clients()
    before = c.snapshot()
    c.request("POST", "/bootstrap", {})
    assert c.snapshot() == before
    assert before["accounts"] == []
    response = c.request("POST", "/categories", {"name": "Моя категория", "kind": "expense"})
    category = response.json()
    account = c.account()
    c.operation(account, category_id=category["id"])
    assert c.request("DELETE", "/categories/" + category["id"], {"expected_version": 1}).status_code == 409
    assert c.request("PUT", "/categories/" + category["id"], {"name": "Изменена", "kind": "expense", "archived": True, "expected_version": 1}).status_code == 200
    assert any(r["name"] == "Изменена" and r["archived"] for r in c.snapshot()["categories"])
    other = next(r for r in c.snapshot()["categories"] if r["name"] == "Другое" and r["kind"] == "expense")
    assert c.request("DELETE", "/categories/" + other["id"], {"expected_version": 1}).status_code == 409
    unused = c.request("POST", "/categories", {"name": "Удаляемая", "kind": "expense"}).json()
    assert c.request("DELETE", "/categories/" + unused["id"], {"expected_version": 1}).status_code == 200
    c.request("POST", "/bootstrap", {})
    assert not any(r["id"] == unused["id"] for r in c.snapshot()["categories"])


@pytest.mark.parametrize("amount", ["0", "-1", "1.01", "NaN", "9000000000000001", 1.5, True])
def test_invalid_amounts_rejected(clients, amount):
    c = clients()
    a = c.account()
    category = next(r for r in c.snapshot()["categories"] if r["kind"] == "expense")
    assert c.request("POST", "/operations", dict(kind="expense", occurred_on="2026-01-01", account_id=a["id"], category_id=category["id"], amount_minor=amount)).status_code == 422
    assert c.snapshot()["operations"] == []


def test_invalid_transfers_precision_and_latest_first(clients):
    c = clients()
    a, b = c.account(opening="9000000000000000"), c.account(currency="EUR")
    body = dict(kind="transfer", occurred_on="2026-01-01", account_id=a["id"], destination_account_id=a["id"], amount_minor="1")
    assert c.request("POST", "/operations", body).status_code == 422
    assert c.request("POST", "/operations", {**body, "destination_account_id": b["id"]}).status_code == 422
    c.operation(a, amount="1", occurred_on="2026-02-01")
    c.operation(a, "income", amount="2", occurred_on="2026-03-01")
    data = c.snapshot()
    assert data["balances"]["KZT"]["total_minor"] == "9000000000000001"
    assert [r["occurred_on"] for r in data["operations"]] == ["2026-03-01", "2026-02-01"]
