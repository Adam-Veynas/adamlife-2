"""User-owned earmarks, separate from money movements; month-effective deposit plans."""
from datetime import date
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import Field, field_validator
from sqlalchemy import select

from app.finance import (AccountInput, CurrencyCode, Input, Minor, audit, fail, finance_session,
                         money, owned, snapshot, touch, version)
from app.models import Account, DepositPlanVersion, GoalAllocation, SavingsGoal

router = APIRouter(prefix="/finance", tags=["savings"])


class AllocationInput(Input):
    account_id: UUID
    amount_minor: Minor


class GoalInput(Input):
    name: str = Field(min_length=1, max_length=120)
    target_minor: Minor
    currency: CurrencyCode
    deadline: date | None = None
    mode: Literal["manual", "linked"]
    manual_minor: Minor | None = None
    allocations: list[AllocationInput] = Field(default_factory=list)
    expected_version: int | None = Field(default=None, ge=1)
    _name = field_validator("name")(AccountInput.name_not_blank.__func__)


class StatusInput(Input):
    status: Literal["active", "completed", "archived"]
    expected_version: int = Field(ge=1)


class PlanInput(Input):
    amount_minor: Minor | None
    expected_revision: int = Field(ge=0)


def progress(target, collected):
    return dict(collected_minor=str(collected), remaining_minor=str(max(target - collected, 0)),
                percent=min(100, collected * 100 // target))


def goal_data(goal, allocations, as_of):
    rows = [a for a in allocations if a.goal_id == goal.id]
    collected = goal.manual_minor if goal.mode == "manual" else sum(a.amount_minor for a in rows)
    if goal.status == "archived":
        collected = goal.archived_progress_minor or 0
    remaining = max(goal.target_minor - collected, 0)
    months = ((goal.deadline.year - as_of.year) * 12 + goal.deadline.month - as_of.month + 1
              if goal.deadline and goal.deadline >= as_of else None)
    return dict(id=str(goal.id), name=goal.name, currency=goal.currency, target_minor=str(goal.target_minor),
                mode=goal.mode, manual_minor=str(goal.manual_minor) if goal.manual_minor is not None else None,
                deadline=goal.deadline.isoformat() if goal.deadline else None, status=goal.status, version=goal.version,
                allocations=[dict(account_id=str(a.account_id), amount_minor=str(a.amount_minor)) for a in rows],
                monthly_minor=str((remaining + months - 1) // months) if months and goal.status == "active" else None,
                overdue=bool(goal.deadline and goal.deadline < as_of and remaining and goal.status == "active"),
                **progress(goal.target_minor, collected))


@router.get("/savings")
def savings_snapshot(auth=Depends(finance_session)):
    session, _ = auth
    ledger = snapshot(auth)
    allocations = list(session.scalars(select(GoalAllocation)))
    amounts = {}
    for allocation in allocations:
        key = str(allocation.account_id)
        amounts[key] = amounts.get(key, 0) + allocation.amount_minor
    accounts = []
    for account in ledger["accounts"]:
        allocated = amounts.get(account["id"], 0)
        positive = max(int(account["balance_minor"]), 0)
        accounts.append({**account, "allocated_minor": str(allocated), "free_minor": str(max(positive - allocated, 0)),
                         "deficit_minor": str(max(allocated - positive, 0))})
    return dict(as_of=ledger["as_of"], accounts=accounts,
                goals=[goal_data(g, allocations, date.fromisoformat(ledger["as_of"]))
                       for g in session.scalars(select(SavingsGoal).order_by(SavingsGoal.created_at.desc(), SavingsGoal.id))])


def write_goal(session, uid, body, goal, auth):
    if body.currency != goal.currency:
        fail("CURRENCY_IMMUTABLE", "Валюту существующей цели изменить нельзя")
    target = money(body.target_minor, positive=True)
    manual = money(body.manual_minor) if body.manual_minor is not None else None
    if body.mode == "manual" and (manual is None or manual < 0 or body.allocations):
        fail("GOAL_MODE", "Ручной прогресс должен быть неотрицательным и без привязки к счетам", 422)
    if body.mode == "linked" and manual is not None:
        fail("GOAL_MODE", "Для привязанной цели ручной прогресс не используется", 422)
    allocations = list(session.scalars(select(GoalAllocation)))
    old = {a.account_id: a for a in allocations if a.goal_id == goal.id}
    proposed = {}
    balances = {UUID(a["id"]): int(a["balance_minor"]) for a in snapshot(auth)["accounts"]}
    for item in body.allocations:
        if item.account_id in proposed:
            fail("DUPLICATE_ACCOUNT", "Счёт указан дважды", 422)
        amount = money(item.amount_minor)
        if amount < 0:
            fail("INVALID_ALLOCATION", "Распределение не может быть отрицательным", 422)
        proposed[item.account_id] = amount
        account = owned(session, Account, item.account_id)
        if account.currency != goal.currency:
            fail("CURRENCY_MISMATCH", "Счёт и цель должны быть в одной валюте", 422)
        previous = old[item.account_id].amount_minor if item.account_id in old else 0
        if account.archived_at and amount > previous:
            fail("ACCOUNT_ARCHIVED", "Архивный счёт: можно только уменьшить или переназначить распределение")
        others = sum(a.amount_minor for a in allocations if a.account_id == account.id and a.goal_id != goal.id)
        # Partial repairs of an existing deficit remain possible. New/increased
        # allocations must fit the current balance while holding the user's ledger lock.
        if amount > previous and others + amount > max(balances[account.id], 0):
            fail("INSUFFICIENT_FREE_FUNDS", "Недостаточно свободных средств на счёте")
    for account_id, row in old.items():
        if not proposed.get(account_id):
            session.delete(row)
        else:
            row.amount_minor = proposed[account_id]
    for account_id, amount in proposed.items():
        if amount and account_id not in old:
            session.add(GoalAllocation(user_id=uid, goal_id=goal.id, account_id=account_id,
                                       currency=goal.currency, amount_minor=amount))
    goal.name, goal.target_minor, goal.deadline = body.name, target, body.deadline
    goal.mode, goal.manual_minor = body.mode, manual


@router.post("/goals", status_code=201)
def create_goal(body: GoalInput, auth=Depends(finance_session)):
    session, uid = auth
    # Validate before the first flush so malformed modes return an API error, not a constraint error.
    goal = SavingsGoal(user_id=uid, currency=body.currency, name=body.name,
                       target_minor=money(body.target_minor, positive=True), mode="linked", status="active")
    session.add(goal)
    session.flush()
    write_goal(session, uid, body, goal, auth)
    session.flush()
    result = next(g for g in savings_snapshot(auth)["goals"] if g["id"] == str(goal.id))
    audit(session, uid, goal, "created", result)
    return result


@router.put("/goals/{identifier}")
def edit_goal(identifier: UUID, body: GoalInput, auth=Depends(finance_session)):
    session, uid = auth
    goal = owned(session, SavingsGoal, identifier)
    version(goal, body.expected_version)
    if goal.status != "active":
        fail("GOAL_INACTIVE", "Сначала верните цель в активные")
    before = next(g for g in savings_snapshot(auth)["goals"] if g["id"] == str(goal.id))
    write_goal(session, uid, body, goal, auth)
    touch(goal)
    session.flush()
    after = next(g for g in savings_snapshot(auth)["goals"] if g["id"] == str(goal.id))
    audit(session, uid, goal, "updated", {"before": before, "after": after})
    return after


@router.post("/goals/{identifier}/status")
def set_status(identifier: UUID, body: StatusInput, auth=Depends(finance_session)):
    session, uid = auth
    goal = owned(session, SavingsGoal, identifier)
    version(goal, body.expected_version)
    state = savings_snapshot(auth)
    before = next(g for g in state["goals"] if g["id"] == str(goal.id))
    if body.status == "completed":
        linked = {a["account_id"] for a in before["allocations"]}
        if goal.status != "active" or before["remaining_minor"] != "0" or any(
                a["id"] in linked and int(a["deficit_minor"]) > 0 for a in state["accounts"]):
            fail("GOAL_NOT_FUNDED", "Завершение доступно для достигнутой активной цели без дефицита")
    if body.status == "archived" and goal.status != "archived":
        goal.archived_progress_minor = int(before["collected_minor"])
        for row in session.scalars(select(GoalAllocation).where(GoalAllocation.goal_id == goal.id)):
            session.delete(row)
    goal.status = body.status
    touch(goal)
    audit(session, uid, goal, "status_changed", {"before": before, "status": body.status})
    return {"ok": True}


def next_month(month):
    return date(month.year + month.month // 12, month.month % 12 + 1, 1)


@router.get("/deposit-plans/{identifier}")
def deposit_plan(identifier: UUID, auth=Depends(finance_session)):
    session, _ = auth
    account = owned(session, Account, identifier)
    if account.kind != "deposit":
        fail("NOT_DEPOSIT", "План доступен только для депозита", 422)
    ledger = snapshot(auth)
    today = date.fromisoformat(ledger["as_of"])
    current_month = today.replace(day=1)
    versions = list(session.scalars(select(DepositPlanVersion).where(DepositPlanVersion.account_id == identifier)
                                   .order_by(DepositPlanVersion.effective_month)))
    facts = {}
    for op in ledger["operations"]:
        if op["kind"] == "transfer" and op["destination_account_id"] == str(identifier) and op["occurred_on"] <= ledger["as_of"]:
            month = op["occurred_on"][:7] + "-01"
            facts[month] = facts.get(month, 0) + int(op["amount_minor"])
    changes = {v.effective_month: v.amount_minor for v in versions}
    month, target, history = versions[0].effective_month if versions else current_month, None, []
    while month <= current_month:
        target = changes.get(month, target)
        actual = facts.get(month.isoformat(), 0)
        history.append(dict(month=month.isoformat(), target_minor=str(target) if target is not None else None,
                            actual_minor=str(actual), remaining_minor=str(max(target - actual, 0)) if target else None,
                            percent=min(100, actual * 100 // target) if target else None))
        if month == current_month:
            break
        month = next_month(month)
    return dict(account_id=str(identifier), currency=account.currency,
                revision=max((v.version for v in versions), default=0), current=history[-1], history=list(reversed(history)))


@router.put("/deposit-plans/{identifier}")
def edit_plan(identifier: UUID, body: PlanInput, auth=Depends(finance_session)):
    session, uid = auth
    account = owned(session, Account, identifier)
    before = deposit_plan(identifier, auth)
    if body.expected_revision != before["revision"]:
        fail("VERSION_CONFLICT", "План уже изменён. Обновите страницу")
    amount = money(body.amount_minor, positive=True) if body.amount_minor is not None else None
    if account.archived_at and amount is not None:
        fail("ACCOUNT_ARCHIVED", "Архивный депозит: можно только отключить план")
    month = date.fromisoformat(before["current"]["month"])
    row = session.scalar(select(DepositPlanVersion).where(DepositPlanVersion.account_id == identifier,
                                                        DepositPlanVersion.effective_month == month))
    if row is None:
        row = DepositPlanVersion(user_id=uid, account_id=identifier, currency=account.currency,
                                 effective_month=month, amount_minor=amount, version=before["revision"] + 1)
        session.add(row)
    else:
        row.amount_minor = amount
        touch(row)
    session.flush()
    audit(session, uid, row, "plan_changed", {"previous_target_minor": before["current"]["target_minor"],
                                           "amount_minor": str(amount) if amount is not None else None,
                                           "effective_month": month.isoformat()})
    return deposit_plan(identifier, auth)
