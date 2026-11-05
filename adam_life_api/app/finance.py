"""Authenticated financial ledger. Integer minor units on disk, decimal strings on wire."""
from datetime import date, datetime, timezone
import hmac
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import or_, select, text

from app.auth import authenticated_session, csrf_token, require_origin
from app.errors import APIError
from app.models import Account, AuditEvent, Category, PaymentOccurrence, PaymentSchedule, Transaction, User

router = APIRouter(prefix="/finance", tags=["finance"])
CurrencyCode = Literal["KZT", "USD", "EUR"]
Minor = Annotated[str, Field(pattern=r"^-?(0|[1-9][0-9]{0,15})$")]
MAX_MINOR = 9_000_000_000_000_000


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AccountInput(Input):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["bank", "cash", "deposit"]
    bank_code: str | None = Field(default=None, max_length=40)
    currency: CurrencyCode
    opening_balance_minor: Minor
    opening_date: date
    archived: bool = False
    expected_version: int | None = Field(default=None, ge=1)
    opening_change_reason: str | None = Field(default=None, max_length=500)

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value):
        if not value.strip():
            raise ValueError("Название обязательно")
        return value.strip()


class CategoryInput(Input):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["income", "expense"]
    archived: bool = False
    expected_version: int | None = Field(default=None, ge=1)
    _name = field_validator("name")(AccountInput.name_not_blank.__func__)


class OperationInput(Input):
    kind: Literal["income", "expense", "transfer"]
    occurred_on: date
    account_id: UUID
    destination_account_id: UUID | None = None
    amount_minor: Minor
    category_id: UUID | None = None
    comment: str | None = Field(default=None, max_length=1000)
    expected_version: int | None = Field(default=None, ge=1)


class VersionInput(Input):
    expected_version: int = Field(ge=1)


def fail(code, message, status=409):
    raise APIError(status, code, message)


def money(value: str, positive=False):
    result = int(value)
    if abs(result) > MAX_MINOR or (positive and result <= 0):
        fail("INVALID_AMOUNT", "Укажите корректную сумму", 422)
    return result


def finance_session(request: Request, auth=Depends(authenticated_session, scope="function")):
    if request.method != "GET":
        require_origin(request)
        header = request.headers.get("x-csrf-token", "")
        if len(header) != 64 or not header.isascii() or not hmac.compare_digest(header, csrf_token(auth[3])):
            fail("CSRF_REJECTED", "Обновите страницу и повторите действие", 403)
    session, _, user, _ = auth
    # One short ledger transaction per user. Different users never block each other.
    # Also gives the snapshot a consistent view of balances and operations.
    session.scalar(select(User).where(User.id == user.id).with_for_update())
    return session, user.id


def owned(session, model, identifier):
    row = session.get(model, identifier)
    if row is None or (isinstance(row, Transaction) and row.deleted_at is not None):
        fail("NOT_FOUND", "Запись не найдена", 404)
    return row


def version(row, expected):
    if expected != row.version:
        fail("VERSION_CONFLICT", "Запись уже изменена. Обновите страницу")


def touch(row):
    row.version += 1
    row.updated_at = datetime.now(timezone.utc)


def audit(session, user_id, entity, action, changes):
    session.add(AuditEvent(user_id=user_id, entity_type=entity.__tablename__, entity_id=entity.id,
                           action=action, changes=changes))


def account_data(row, balance=None):
    return dict(id=str(row.id), name=row.name, kind=row.kind, bank_code=row.bank_code,
                currency=row.currency, opening_balance_minor=str(row.opening_balance_minor),
                opening_date=row.opening_date.isoformat(), archived=row.archived_at is not None,
                version=row.version, balance_minor=str(balance if balance is not None else row.opening_balance_minor))


def category_data(row):
    return dict(id=str(row.id), name=row.name, kind=row.kind, archived=row.archived_at is not None, version=row.version)


def operation_data(row):
    return dict(id=str(row.id), kind=row.kind, occurred_on=row.occurred_on.isoformat(),
                account_id=str(row.destination_account_id if row.kind == "income" else row.source_account_id),
                destination_account_id=str(row.destination_account_id) if row.kind == "transfer" else None,
                currency=row.destination_currency if row.kind == "income" else row.source_currency,
                amount_minor=str(row.destination_amount_minor if row.kind == "income" else row.source_amount_minor),
                category_id=str(row.category_id) if row.category_id else None, comment=row.comment or "", version=row.version)


def balances(accounts, operations, as_of):
    amounts = {row.id: row.opening_balance_minor if row.opening_date <= as_of else 0 for row in accounts}
    for row in operations:
        if row.deleted_at is not None or row.occurred_on > as_of:
            continue
        if row.source_account_id:
            amounts[row.source_account_id] -= row.source_amount_minor
        if row.destination_account_id:
            amounts[row.destination_account_id] += row.destination_amount_minor
    totals = {code: dict(total_minor=0, current_minor=0, deposit_minor=0) for code in ("KZT", "USD", "EUR")}
    for row in accounts:
        # Archive retains the money as well as the history.
        bucket = totals[row.currency]
        bucket["total_minor"] += amounts[row.id]
        bucket["deposit_minor" if row.kind == "deposit" else "current_minor"] += amounts[row.id]
    return amounts, {code: {key: str(value) for key, value in values.items()} for code, values in totals.items()}


@router.post("/bootstrap")
def bootstrap(auth=Depends(finance_session)):
    session, uid = auth
    marker = session.scalar(select(AuditEvent.id).where(AuditEvent.action == "categories_initialized").limit(1))
    if marker is None:
        existing = {(r.kind, r.name) for r in session.scalars(select(Category))}
        for kind, names in {
            "income": ["Зарплата", "Бонус", "Подработка", "Проценты по депозиту", "Другое"],
            "expense": ["Продукты", "Жильё", "Транспорт", "Развлечения", "Кредиты", "Покупки", "Здоровье", "Другое"],
        }.items():
            for index, name in enumerate(names):
                if (kind, name) not in existing:
                    session.add(Category(user_id=uid, name=name, kind=kind, sort_order=index))
        session.add(AuditEvent(user_id=uid, entity_type="user", entity_id=uid, action="categories_initialized", changes={}))
    return {"ok": True}


@router.get("/snapshot")
def snapshot(auth=Depends(finance_session)):
    session, uid = auth
    user = session.get(User, uid)
    as_of = session.scalar(text("SELECT (CURRENT_TIMESTAMP AT TIME ZONE :zone)::date"), {"zone": user.timezone})
    accounts = list(session.scalars(select(Account).order_by(Account.created_at, Account.id)))
    categories = list(session.scalars(select(Category).order_by(Category.kind, Category.sort_order, Category.name, Category.id)))
    operations = list(session.scalars(select(Transaction).where(Transaction.deleted_at.is_(None)).order_by(Transaction.occurred_on.desc(), Transaction.created_at.desc(), Transaction.id.desc())))
    values, totals = balances(accounts, operations, as_of)
    return dict(accounts=[account_data(r, values[r.id]) for r in accounts], categories=[category_data(r) for r in categories],
                operations=[operation_data(r) for r in operations], balances=totals, as_of=as_of.isoformat())


def account_history(session, identifier):
    return session.scalar(select(Transaction.id).where(or_(Transaction.source_account_id == identifier,
                         Transaction.destination_account_id == identifier)).limit(1)) is not None


@router.post("/accounts", status_code=201)
def create_account(body: AccountInput, auth=Depends(finance_session)):
    session, uid = auth
    row = Account(user_id=uid, name=body.name, kind=body.kind, bank_code=body.bank_code if body.kind != "cash" else None,
                  currency=body.currency, opening_balance_minor=money(body.opening_balance_minor), opening_date=body.opening_date)
    session.add(row)
    session.flush()
    audit(session, uid, row, "created", account_data(row))
    return account_data(row)


@router.put("/accounts/{identifier}")
def edit_account(identifier: UUID, body: AccountInput, auth=Depends(finance_session)):
    session, uid = auth
    row = owned(session, Account, identifier)
    version(row, body.expected_version)
    if row.currency != body.currency:
        fail("CURRENCY_IMMUTABLE", "Валюта счёта неизменна. Создайте другой счёт")
    opening = money(body.opening_balance_minor)
    changed = opening != row.opening_balance_minor or body.opening_date != row.opening_date
    if changed:
        if not body.opening_change_reason or not body.opening_change_reason.strip():
            fail("OPENING_REASON_REQUIRED", "Укажите причину изменения начального остатка или даты", 422)
        earlier = session.scalar(select(Transaction.id).where(or_(Transaction.source_account_id == row.id,
                    Transaction.destination_account_id == row.id), Transaction.occurred_on < body.opening_date).limit(1))
        if earlier:
            fail("OPENING_BOUNDARY", "Дата начала учёта исключает существующие операции")
    before = account_data(row)
    row.name, row.kind = body.name, body.kind
    row.bank_code = body.bank_code if body.kind != "cash" else None
    row.opening_balance_minor, row.opening_date = opening, body.opening_date
    row.archived_at = datetime.now(timezone.utc) if body.archived else None
    touch(row)
    session.flush()  # Existing baseline guard writes old/new amounts atomically.
    audit(session, uid, row, "updated", {"before": before, "after": account_data(row), "opening_change_reason": body.opening_change_reason if changed else None})
    return account_data(row)


@router.delete("/accounts/{identifier}")
def delete_account(identifier: UUID, body: VersionInput, auth=Depends(finance_session)):
    session, uid = auth
    row = owned(session, Account, identifier)
    version(row, body.expected_version)
    if account_history(session, row.id) or session.scalar(select(PaymentSchedule.id).where(PaymentSchedule.account_id == row.id).limit(1)) or session.scalar(select(PaymentOccurrence.id).where(PaymentOccurrence.account_id == row.id).limit(1)):
        fail("ACCOUNT_HAS_HISTORY", "У счёта есть история. Архивируйте его")
    audit(session, uid, row, "deleted", account_data(row))
    session.delete(row)
    return {"ok": True}


@router.post("/categories", status_code=201)
def create_category(body: CategoryInput, auth=Depends(finance_session)):
    session, uid = auth
    row = Category(user_id=uid, name=body.name, kind=body.kind)
    session.add(row)
    session.flush()
    audit(session, uid, row, "created", category_data(row))
    return category_data(row)


def guard_other(row, body=None):
    if row.kind == "expense" and row.name == "Другое" and (body is None or body.name != row.name or body.kind != row.kind or body.archived):
        fail("OTHER_REQUIRED", "Категория «Другое» нужна для неопределённых расходов")


@router.put("/categories/{identifier}")
def edit_category(identifier: UUID, body: CategoryInput, auth=Depends(finance_session)):
    session, uid = auth
    row = owned(session, Category, identifier)
    version(row, body.expected_version)
    guard_other(row, body)
    if row.kind != body.kind:
        fail("CATEGORY_KIND_IMMUTABLE", "Для другого типа создайте новую категорию")
    before = category_data(row)
    row.name, row.archived_at = body.name, datetime.now(timezone.utc) if body.archived else None
    touch(row)
    audit(session, uid, row, "updated", {"before": before, "after": category_data(row)})
    return category_data(row)


@router.delete("/categories/{identifier}")
def delete_category(identifier: UUID, body: VersionInput, auth=Depends(finance_session)):
    session, uid = auth
    row = owned(session, Category, identifier)
    version(row, body.expected_version)
    guard_other(row)
    if session.scalar(select(Transaction.id).where(Transaction.category_id == row.id).limit(1)):
        fail("CATEGORY_HAS_HISTORY", "Категория используется в истории. Архивируйте её")
    audit(session, uid, row, "deleted", category_data(row))
    session.delete(row)
    return {"ok": True}


def operation_values(session, body):
    amount = money(body.amount_minor, positive=True)
    account = owned(session, Account, body.account_id)
    destination = None
    if body.kind == "transfer":
        if not body.destination_account_id or body.destination_account_id == account.id:
            fail("TRANSFER_ACCOUNTS", "Выберите два разных счёта", 422)
        destination = owned(session, Account, body.destination_account_id)
        if account.currency != destination.currency:
            fail("TRANSFER_CURRENCY", "Для перевода выберите счета в одной валюте", 422)
        if body.category_id:
            fail("TRANSFER_CATEGORY", "У перевода нет категории дохода или расхода", 422)
    else:
        if body.destination_account_id:
            fail("INVALID_OPERATION", "Второй счёт используется только для перевода", 422)
        if not body.category_id:
            fail("CATEGORY_REQUIRED", "Выберите категорию", 422)
        category = owned(session, Category, body.category_id)
        if category.kind != body.kind or category.archived_at:
            fail("CATEGORY_UNAVAILABLE", "Выберите активную категорию нужного типа", 422)
    for row in [account] + ([destination] if destination else []):
        if row.archived_at:
            fail("ACCOUNT_ARCHIVED", "Сначала восстановите счёт из архива")
        if body.occurred_on < row.opening_date:
            fail("OPENING_BOUNDARY", "Операция раньше даты начала учёта счёта", 422)
    income = body.kind == "income"
    return dict(kind=body.kind, occurred_on=body.occurred_on, comment=body.comment,
                category_id=body.category_id, source_account_id=None if income else account.id,
                source_currency=None if income else account.currency, source_amount_minor=None if income else amount,
                destination_account_id=account.id if income else destination.id if destination else None,
                destination_currency=account.currency if income else destination.currency if destination else None,
                destination_amount_minor=amount if income or destination else None)


@router.post("/operations", status_code=201)
def create_operation(body: OperationInput, auth=Depends(finance_session)):
    session, uid = auth
    row = Transaction(user_id=uid, **operation_values(session, body))
    session.add(row)
    session.flush()
    audit(session, uid, row, "created", operation_data(row))
    return operation_data(row)


def payment_guard(session, identifier):
    if session.scalar(select(PaymentOccurrence.id).where(PaymentOccurrence.transaction_id == identifier).limit(1)):
        fail("PAYMENT_LINKED", "Операция связана с обязательным платежом")


@router.put("/operations/{identifier}")
def edit_operation(identifier: UUID, body: OperationInput, auth=Depends(finance_session)):
    session, uid = auth
    row = owned(session, Transaction, identifier)
    version(row, body.expected_version)
    payment_guard(session, identifier)
    before = operation_data(row)
    for key, value in operation_values(session, body).items():
        setattr(row, key, value)
    touch(row)
    audit(session, uid, row, "updated", {"before": before, "after": operation_data(row)})
    return operation_data(row)


@router.delete("/operations/{identifier}")
def delete_operation(identifier: UUID, body: VersionInput, auth=Depends(finance_session)):
    session, uid = auth
    row = owned(session, Transaction, identifier)
    version(row, body.expected_version)
    payment_guard(session, identifier)
    audit(session, uid, row, "deleted", operation_data(row))
    row.deleted_at = datetime.now(timezone.utc)
    touch(row)
    return {"ok": True}
