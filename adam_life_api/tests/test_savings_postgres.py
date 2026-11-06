"""Savings rules through the real authenticated API, PostgreSQL and forced RLS."""
import asyncio
from datetime import date
from uuid import UUID, uuid4

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app import savings
from app.auth import csrf_token
from app.config import Settings
from app.db import build_engine, user_session
from app.models import Base, DepositPlanVersion, GoalAllocation, SavingsGoal
from app.schema import SCHEMA_REVISION
from test_finance_postgres import clients, ORIGIN
from test_postgres import pg_engine, runtime_engine

pytestmark = pytest.mark.postgres


def body(account=None, amount="600", **changes):
    return dict(name="Автомобиль", target_minor="1000", currency="KZT", mode="linked", manual_minor=None,
                allocations=[dict(account_id=account["id"], amount_minor=amount)] if account else [], **changes)


def create(c, payload):
    response = c.request("POST", "/goals", payload)
    assert response.status_code == 201, response.text
    return response.json()


def state(c):
    response = c.request("GET", "/savings")
    assert response.status_code == 200, response.text
    return response.json()


def status(c, goal, target):
    return c.request("POST", f'/goals/{goal["id"]}/status', dict(status=target, expected_version=goal["version"]))


def set_plan(c, account, amount, revision):
    return c.request("PUT", "/deposit-plans/" + account["id"], dict(amount_minor=amount, expected_revision=revision))


def get_plan(c, account):
    r = c.request("GET", "/deposit-plans/" + account["id"])
    assert r.status_code == 200, r.text
    return r.json()


def test_migration_schema_rls_and_no_unscoped_reads(pg_engine, runtime_engine):
    with pg_engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == SCHEMA_REVISION
        assert compare_metadata(MigrationContext.configure(connection, opts={"compare_type": True, "compare_server_default": True}), Base.metadata) == []
        rows = connection.execute(text("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('savings_goals','goal_allocations','deposit_plan_versions')")).all()
        assert len(rows) == 3 and all(a and b for a, b in rows)
    with runtime_engine.connect() as connection:
        for model in (SavingsGoal, GoalAllocation, DepositPlanVersion):
            assert connection.execute(select(model)).all() == []


def test_shared_account_multiple_goals_and_multiple_accounts_no_double_count(clients):
    c = clients()
    a, b = c.account(opening="1000"), c.account(kind="deposit", opening="500")
    before = c.snapshot()
    first = create(c, body(a, "600"))
    create(c, body(a, "400"))
    assert c.request("POST", "/goals", body(a, "1")).status_code == 409
    edit = {**body(a, "600"), "expected_version": first["version"]}
    edit["allocations"].append(dict(account_id=b["id"], amount_minor="500"))
    r = c.request("PUT", "/goals/" + first["id"], edit)
    assert r.status_code == 200 and r.json()["collected_minor"] == "1100"
    assert r.json()["percent"] == 100 and r.json()["remaining_minor"] == "0"
    assert c.snapshot()["balances"] == before["balances"]
    assert c.snapshot()["operations"] == []
    assert all(a["free_minor"] == "0" for a in state(c)["accounts"])
    assert c.request("PUT", "/goals/" + first["id"], edit).status_code == 409
    c.http._transport.app.state.engine.dispose()
    assert len(state(c)["goals"]) == 2


def test_withdrawal_deficit_partial_repair_and_topup_do_not_resize(clients):
    c = clients()
    a, b = c.account(opening="1000"), c.account(opening="1000")
    g = create(c, body(a, "900"))
    op, op_body = c.operation(a, "transfer", "500", b)
    s = state(c)
    assert s["goals"][0]["collected_minor"] == "900"
    assert next(i for i in s["accounts"] if i["id"] == a["id"])["deficit_minor"] == "400"
    r = c.request("PUT", "/goals/" + g["id"], {**body(a, "800"), "expected_version": 1})
    assert r.status_code == 200  # partial repair allowed
    assert c.request("PUT", "/goals/" + g["id"], {**body(a, "801"), "expected_version": 2}).status_code == 409
    assert c.request("PUT", "/operations/" + op["id"], {**op_body, "amount_minor": "100", "expected_version": 1}).status_code == 200
    assert next(i for i in state(c)["accounts"] if i["id"] == a["id"])["free_minor"] == "100"
    assert c.request("DELETE", "/operations/" + op["id"], {"expected_version": 2}).status_code == 200
    assert next(i for i in state(c)["accounts"] if i["id"] == a["id"])["free_minor"] == "200"
    assert state(c)["goals"][0]["collected_minor"] == "800"


@pytest.mark.parametrize("change", [
    {"allocations": [{"account_id": "SELF", "amount_minor": "-1"}]},
    {"allocations": [{"account_id": "SELF", "amount_minor": "1"}] * 2},
    {"target_minor": "0"}, {"target_minor": "-1"}, {"manual_minor": "1"},
    {"mode": "manual", "manual_minor": "1"}, {"mode": "manual", "manual_minor": "-1", "allocations": []},
    {"mode": "manual", "manual_minor": None, "allocations": []}, {"target_minor": "1.01"},
])
def test_invalid_allocations_and_modes_rejected_atomically(clients, change):
    c = clients(); a = c.account(opening="1000")
    payload = {**body(a), **change}
    payload["allocations"] = [{**i, "account_id": a["id"] if i["account_id"] == "SELF" else i["account_id"]} for i in payload["allocations"]]
    assert c.request("POST", "/goals", payload).status_code == 422
    assert state(c)["goals"] == []
    assert state(c)["accounts"][0]["allocated_minor"] == "0"


def test_negative_balance_and_currency_mismatch(clients):
    c = clients(); a = c.account(opening="-1"); usd = c.account(currency="USD")
    assert c.request("POST", "/goals", body(a, "1")).status_code == 409
    assert c.request("POST", "/goals", body(usd, "1")).status_code == 422


def test_manual_progress_mode_switch_completion_archive_restore(clients):
    c = clients(); a = c.account(opening="1000")
    g = create(c, body(a))
    payload = {**body(), "mode": "manual", "manual_minor": "1000", "expected_version": 1}
    r = c.request("PUT", "/goals/" + g["id"], payload)
    assert r.status_code == 200
    assert state(c)["accounts"][0]["free_minor"] == "1000"
    assert c.snapshot()["balances"]["KZT"]["total_minor"] == "1000"
    assert status(c, r.json(), "completed").status_code == 200
    g = state(c)["goals"][0]
    assert g["status"] == "completed"
    assert c.request("PUT", "/goals/" + g["id"], {**payload, "expected_version": g["version"]}).status_code == 409
    assert status(c, g, "archived").status_code == 200
    g = state(c)["goals"][0]
    assert g["collected_minor"] == "1000" and g["allocations"] == []
    assert status(c, g, "active").status_code == 200
    assert state(c)["goals"][0]["collected_minor"] == "1000"


def test_archive_releases_linked_funds_and_preserves_audit(clients, runtime_engine):
    c = clients(); a = c.account(opening="1000")
    g = create(c, {**body(a, "1000"), "target_minor": "1000"})
    assert status(c, g, "completed").status_code == 200
    assert state(c)["accounts"][0]["free_minor"] == "0"
    assert status(c, state(c)["goals"][0], "archived").status_code == 200
    archived = state(c)["goals"][0]
    assert archived["collected_minor"] == "1000" and state(c)["accounts"][0]["free_minor"] == "1000"
    with user_session(runtime_engine, c.uid) as session:
        change = session.execute(text("SELECT changes FROM audit_events WHERE entity_id=:id AND action='status_changed' ORDER BY created_at DESC"), {"id": UUID(g["id"])}).first()[0]
        assert change["before"]["allocations"][0]["amount_minor"] == "1000"
    assert status(c, archived, "active").status_code == 200
    assert state(c)["goals"][0]["collected_minor"] == "0"


def test_completion_rejects_unfunded_and_deficit(clients):
    c = clients(); a = c.account(opening="1000")
    g = create(c, body(a))
    assert status(c, g, "completed").status_code == 409
    g = create(c, {**body(a, "400"), "target_minor": "400"})
    c.operation(a, amount="1")
    assert status(c, g, "completed").status_code == 409


def test_archived_account_reassignment_and_safe_delete(clients):
    c = clients(); a, b = c.account(opening="1000"), c.account(opening="1000")
    g = create(c, body(a))
    assert c.request("DELETE", "/accounts/" + a["id"], {"expected_version": 1}).status_code == 409
    edit = {k: v for k, v in a.items() if k not in {"id", "version", "balance_minor"}}
    assert c.request("PUT", "/accounts/" + a["id"], {**edit, "expected_version": 1, "archived": True}).status_code == 200
    assert state(c)["goals"][0]["allocations"][0]["amount_minor"] == "600"
    assert c.request("PUT", "/goals/" + g["id"], {**body(a, "601"), "expected_version": 1}).status_code == 409
    assert c.request("PUT", "/goals/" + g["id"], {**body(b, "600"), "expected_version": 1}).status_code == 200
    assert next(a for a in state(c)["accounts"] if a["archived"])["allocated_minor"] == "0"


def test_two_users_api_and_database_isolation_and_csrf(clients, runtime_engine):
    a, b = clients(), clients()
    account = a.account(kind="deposit", opening="1000")
    goal = create(a, body(account))
    assert set_plan(a, account, "100", 0).status_code == 200
    assert state(b)["goals"] == []
    assert b.request("POST", "/goals", body(account)).status_code == 404
    assert b.request("PUT", "/goals/" + goal["id"], {**body(), "expected_version": 1}).status_code == 404
    assert status(b, goal, "archived").status_code == 404
    assert b.request("GET", "/deposit-plans/" + account["id"]).status_code == 404
    assert set_plan(b, account, "1", 1).status_code == 404
    assert a.request("POST", "/goals", body(), headers={"Origin": ORIGIN}).status_code == 403
    assert a.request("POST", "/goals", {**body(), "user_id": str(b.uid)}).status_code == 422
    own_goal = create(b, body())
    with user_session(runtime_engine, b.uid) as session:
        assert session.get(SavingsGoal, UUID(goal["id"])) is None
        assert list(session.scalars(select(GoalAllocation))) == []
        assert list(session.scalars(select(DepositPlanVersion))) == []
    with pytest.raises(DBAPIError):
        with user_session(runtime_engine, b.uid) as session:
            session.add(GoalAllocation(user_id=b.uid, goal_id=UUID(own_goal["id"]), account_id=UUID(account["id"]), currency="KZT", amount_minor=1))


def test_concurrent_allocations_cannot_overspend(clients, runtime_engine):
    c = clients(); a = c.account(opening="1000")
    engine = build_engine(Settings(_env_file=None, database_url=runtime_engine.url.render_as_string(hide_password=False), db_pool_size=4, db_max_overflow=0))
    app = c.http._transport.app
    app.state.engine = engine
    async def requests():
        return await asyncio.gather(*(c.http.post("/finance/goals", json=body(a, "600"), headers={"Origin": ORIGIN, "X-CSRF-Token": csrf_token(c.raw)}) for _ in range(2)))
    try:
        responses = asyncio.run(requests())
        assert sorted(r.status_code for r in responses) == [201, 409]
        assert state(c)["accounts"][0]["allocated_minor"] == "600"
    finally:
        app.state.engine = runtime_engine
        engine.dispose()


def test_monthly_needed_and_expired_deadline(clients):
    c = clients()
    today = state(c)["as_of"]
    g = create(c, {**body(), "mode": "manual", "manual_minor": "1", "deadline": today})
    assert g["monthly_minor"] == "999" and not g["overdue"]
    g = create(c, {**body(), "deadline": "2000-01-01"})
    assert g["monthly_minor"] is None and g["overdue"]
    g = create(c, body())
    assert g["monthly_minor"] is None and not g["overdue"]


def test_plan_history_carry_forward_change_disable_and_actual_transfers(clients, monkeypatch):
    real_snapshot = savings.snapshot
    clock = ["2026-02-28"]
    monkeypatch.setattr(savings, "snapshot", lambda auth: {**real_snapshot(auth), "as_of": clock[0]})
    c = clients(); a, dep = c.account(opening="100000"), c.account(kind="deposit", opening="1000")
    assert set_plan(c, dep, "1000", 0).status_code == 200
    c.operation(dep, "income", "10000")
    c.operation(a, "transfer", "300", dep)
    assert get_plan(c, dep)["current"] == dict(month="2026-02-01", target_minor="1000", actual_minor="300", remaining_minor="700", percent=30)
    clock[0] = "2026-04-30"
    assert set_plan(c, dep, "2000", 1).status_code == 200
    op, payload = c.operation(a, "transfer", "1000", dep, occurred_on="2026-04-05")
    c.operation(dep, "transfer", "100", a, occurred_on="2026-04-06")
    c.operation(a, "transfer", "900", dep, occurred_on="2026-05-01")
    history = get_plan(c, dep)["history"]
    assert [r["target_minor"] for r in history] == ["2000", "1000", "1000"]
    assert [r["actual_minor"] for r in history] == ["1000", "0", "300"]
    assert set_plan(c, dep, "2000", 1).status_code == 409
    assert c.request("PUT", "/operations/" + op["id"], {**payload, "amount_minor": "500", "expected_version": 1}).status_code == 200
    assert get_plan(c, dep)["current"]["actual_minor"] == "500"
    assert c.request("DELETE", "/operations/" + op["id"], {"expected_version": 2}).status_code == 200
    assert get_plan(c, dep)["current"]["actual_minor"] == "0"
    assert set_plan(c, dep, None, 2).status_code == 200
    history = get_plan(c, dep)["history"]
    assert [r["target_minor"] for r in history] == [None, "1000", "1000"]
    assert history[0]["percent"] is None
    clock[0] = "2026-05-31"
    assert get_plan(c, dep)["current"]["target_minor"] is None
    assert set_plan(c, dep, "500", 3).status_code == 200
    assert get_plan(c, dep)["current"]["percent"] == 100
    assert c.request("DELETE", "/accounts/" + dep["id"], {"expected_version": 1}).status_code == 409


@pytest.mark.parametrize("amount", ["0", "-1", "1.20", "9999999999999999"])
def test_invalid_plan_amount(clients, amount):
    c = clients(); dep = c.account(kind="deposit")
    assert set_plan(c, dep, amount, 0).status_code == 422
    assert get_plan(c, dep)["revision"] == 0


def test_plan_only_deposit_and_archived_disable(clients):
    c = clients(); a = c.account(); dep = c.account(kind="deposit")
    assert set_plan(c, a, "100", 0).status_code == 422
    assert set_plan(c, dep, "100", 0).status_code == 200
    payload = {k: v for k, v in dep.items() if k not in {"id", "version", "balance_minor"}}
    assert c.request("PUT", "/accounts/" + dep["id"], {**payload, "kind": "bank", "expected_version": 1}).status_code == 409
    assert c.request("PUT", "/accounts/" + dep["id"], {**payload, "archived": True, "expected_version": 1}).status_code == 200
    assert set_plan(c, dep, "200", 1).status_code == 409
    assert set_plan(c, dep, None, 1).status_code == 200
