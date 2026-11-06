"""Persistence schema only. No financial CRUD, auth, or analytics services yet.

Money is signed BIGINT minor units, never a float. An account owns its currency.
Composite foreign keys enforce tenant ownership even when application code errs.
"""
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKey,
    ForeignKeyConstraint, Index, Integer, MetaData, String, Text,
    UniqueConstraint, Uuid, Numeric, func, text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention={
        "ix": "ix_%(table_name)s_%(column_0_name)s",
        "uq": "uq_%(table_name)s_%(column_0_name)s",
        "ck": "ck_%(table_name)s_%(constraint_name)s",
        "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
        "pk": "pk_%(table_name)s",
    })


class Identity:
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Owned:
    user_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)


class Versioned:
    version: Mapped[int] = mapped_column(Integer, server_default=text("1"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class User(Identity, Base):
    __tablename__ = "users"
    # Stable Google subject; email is profile information, never an identity key.
    google_sub: Mapped[str | None] = mapped_column(String(255), unique=True)
    email: Mapped[str | None] = mapped_column(String(320))
    display_name: Mapped[str] = mapped_column(String(200))
    timezone: Mapped[str] = mapped_column(String(64), server_default="Asia/Qyzylorda")


class Currency(Base):
    __tablename__ = "currencies"
    code: Mapped[str] = mapped_column(String(3), primary_key=True)
    minor_unit_digits: Mapped[int] = mapped_column(Integer, nullable=False)
    __table_args__ = (
        CheckConstraint("code IN ('KZT', 'USD', 'EUR')", name="supported_code"),
        CheckConstraint("minor_unit_digits = 2", name="minor_digits"),
    )


class Account(Identity, Owned, Versioned, Base):
    __tablename__ = "accounts"
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(12))
    bank_code: Mapped[str | None] = mapped_column(String(40))
    currency: Mapped[str] = mapped_column(String(3), ForeignKey("currencies.code", ondelete="RESTRICT"))
    opening_balance_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    opening_date: Mapped[date] = mapped_column(Date, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deposit_type: Mapped[str | None] = mapped_column(String(12))
    annual_rate: Mapped[Decimal | None] = mapped_column(Numeric(9, 4))
    deposit_opened_on: Mapped[date | None] = mapped_column(Date)
    deposit_ends_on: Mapped[date | None] = mapped_column(Date)
    __table_args__ = (
        UniqueConstraint("user_id", "id", name="uq_accounts_owner_id"),
        UniqueConstraint("user_id", "id", "currency", name="uq_accounts_owner_id_currency"),
        CheckConstraint("kind IN ('bank', 'cash', 'deposit')", name="kind"),
        CheckConstraint("deposit_type IN ('savings', 'term')", name="deposit_type"),
        CheckConstraint("annual_rate >= 0 AND annual_rate <= 99999.9999", name="annual_rate"),
        CheckConstraint("deposit_ends_on >= deposit_opened_on", name="deposit_dates"),
        CheckConstraint("length(trim(name)) > 0", name="name"),
        CheckConstraint("version > 0", name="version"),
        Index("ix_accounts_user_id", "user_id"),
    )


class Category(Identity, Owned, Versioned, Base):
    __tablename__ = "categories"
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(12))
    sort_order: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        UniqueConstraint("user_id", "id", "kind", name="uq_categories_owner_id_kind"),
        CheckConstraint("kind IN ('income', 'expense')", name="kind"),
        CheckConstraint("length(trim(name)) > 0", name="name"),
        CheckConstraint("version > 0", name="version"),
        Index("ix_categories_user_id", "user_id"),
    )


class Transaction(Identity, Owned, Versioned, Base):
    __tablename__ = "transactions"
    kind: Mapped[str] = mapped_column(String(12))
    occurred_on: Mapped[date] = mapped_column(Date)
    source_account_id: Mapped[UUID | None] = mapped_column(Uuid)
    source_currency: Mapped[str | None] = mapped_column(String(3))
    source_amount_minor: Mapped[int | None] = mapped_column(BigInteger)
    destination_account_id: Mapped[UUID | None] = mapped_column(Uuid)
    destination_currency: Mapped[str | None] = mapped_column(String(3))
    destination_amount_minor: Mapped[int | None] = mapped_column(BigInteger)
    category_id: Mapped[UUID | None] = mapped_column(Uuid)
    comment: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(12), server_default="manual")
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        UniqueConstraint("user_id", "id", name="uq_transactions_owner_id"),
        # Used by a payment occurrence to reference an actual expense, not a transfer.
        UniqueConstraint("user_id", "id", "kind", "source_account_id", "source_currency", "source_amount_minor",
                         name="uq_transactions_payment_link"),
        ForeignKeyConstraint(["user_id", "source_account_id", "source_currency"],
                             ["accounts.user_id", "accounts.id", "accounts.currency"],
                             name="fk_transactions_source_account", ondelete="RESTRICT"),
        ForeignKeyConstraint(["user_id", "destination_account_id", "destination_currency"],
                             ["accounts.user_id", "accounts.id", "accounts.currency"],
                             name="fk_transactions_destination_account", ondelete="RESTRICT"),
        ForeignKeyConstraint(["user_id", "category_id", "kind"],
                             ["categories.user_id", "categories.id", "categories.kind"],
                             name="fk_transactions_category", ondelete="RESTRICT"),
        CheckConstraint("kind IN ('income', 'expense', 'transfer')", name="kind"),
        CheckConstraint("source IN ('manual', 'import')", name="source"),
        CheckConstraint("version > 0", name="version"),
        CheckConstraint("""
            (kind = 'income' AND source_account_id IS NULL AND source_currency IS NULL
             AND source_amount_minor IS NULL AND destination_account_id IS NOT NULL
             AND destination_currency IS NOT NULL AND destination_amount_minor IS NOT NULL
             AND category_id IS NOT NULL)
            OR (kind = 'expense' AND destination_account_id IS NULL AND destination_currency IS NULL
             AND destination_amount_minor IS NULL AND source_account_id IS NOT NULL
             AND source_currency IS NOT NULL AND source_amount_minor IS NOT NULL AND category_id IS NOT NULL)
            OR (kind = 'transfer' AND source_account_id IS NOT NULL AND source_currency IS NOT NULL
             AND source_amount_minor IS NOT NULL AND destination_account_id IS NOT NULL
             AND destination_currency IS NOT NULL AND destination_amount_minor IS NOT NULL AND category_id IS NULL)
        """, name="shape"),
        CheckConstraint("source_amount_minor IS NULL OR source_amount_minor > 0", name="source_positive"),
        CheckConstraint("destination_amount_minor IS NULL OR destination_amount_minor > 0", name="destination_positive"),
        CheckConstraint("source_account_id IS NULL OR destination_account_id IS NULL OR source_account_id <> destination_account_id",
                        name="different_accounts"),
        CheckConstraint("kind <> 'transfer' OR source_currency <> destination_currency OR source_amount_minor = destination_amount_minor",
                        name="same_currency_transfer"),
        Index("ix_transactions_user_date", "user_id", "occurred_on", "id"),
        Index("ix_transactions_user_source", "user_id", "source_account_id"),
        Index("ix_transactions_user_destination", "user_id", "destination_account_id"),
    )


class PaymentSchedule(Identity, Owned, Versioned, Base):
    __tablename__ = "payment_schedules"
    title: Mapped[str] = mapped_column(String(200))
    account_id: Mapped[UUID] = mapped_column(Uuid)
    currency: Mapped[str] = mapped_column(String(3))
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    frequency: Mapped[str] = mapped_column(String(12))
    starts_on: Mapped[date] = mapped_column(Date)
    ends_on: Mapped[date | None] = mapped_column(Date)
    day_of_month: Mapped[int | None] = mapped_column(Integer)
    active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    __table_args__ = (
        UniqueConstraint("user_id", "id", name="uq_payment_schedules_owner_id"),
        ForeignKeyConstraint(["user_id", "account_id", "currency"],
                             ["accounts.user_id", "accounts.id", "accounts.currency"],
                             name="fk_payment_schedules_account", ondelete="RESTRICT"),
        CheckConstraint("amount_minor > 0", name="positive_amount"),
        CheckConstraint("length(trim(title)) > 0", name="title"),
        CheckConstraint("version > 0", name="version"),
        CheckConstraint("ends_on IS NULL OR ends_on >= starts_on", name="date_range"),
        CheckConstraint("(frequency = 'once' AND day_of_month IS NULL) OR (frequency = 'monthly' AND day_of_month IS NOT NULL AND day_of_month BETWEEN 1 AND 31)",
                        name="frequency"),
        Index("ix_payment_schedules_user_id", "user_id"),
    )


class PaymentOccurrence(Identity, Owned, Versioned, Base):
    __tablename__ = "payment_occurrences"
    schedule_id: Mapped[UUID] = mapped_column(Uuid)
    period_start: Mapped[date] = mapped_column(Date)
    due_on: Mapped[date] = mapped_column(Date)
    title: Mapped[str] = mapped_column(String(200))
    account_id: Mapped[UUID] = mapped_column(Uuid)
    currency: Mapped[str] = mapped_column(String(3))
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    transaction_id: Mapped[UUID | None] = mapped_column(Uuid)
    transaction_kind: Mapped[str] = mapped_column(String(12), server_default="expense")
    __table_args__ = (
        UniqueConstraint("user_id", "schedule_id", "period_start", name="uq_payment_occurrences_period"),
        UniqueConstraint("user_id", "transaction_id", name="uq_payment_occurrences_transaction"),
        ForeignKeyConstraint(["user_id", "schedule_id"], ["payment_schedules.user_id", "payment_schedules.id"],
                             name="fk_payment_occurrences_schedule", ondelete="RESTRICT"),
        ForeignKeyConstraint(["user_id", "account_id", "currency"],
                             ["accounts.user_id", "accounts.id", "accounts.currency"],
                             name="fk_payment_occurrences_account", ondelete="RESTRICT"),
        ForeignKeyConstraint(["user_id", "transaction_id", "transaction_kind", "account_id", "currency", "amount_minor"],
                             ["transactions.user_id", "transactions.id", "transactions.kind", "transactions.source_account_id",
                              "transactions.source_currency", "transactions.source_amount_minor"],
                             name="fk_payment_occurrences_expense", ondelete="RESTRICT"),
        CheckConstraint("transaction_kind = 'expense'", name="expense_only"),
        CheckConstraint("amount_minor > 0", name="positive_amount"),
        CheckConstraint("length(trim(title)) > 0", name="title"),
        CheckConstraint("version > 0", name="version"),
        CheckConstraint("(paid_at IS NULL AND transaction_id IS NULL) OR (paid_at IS NOT NULL AND transaction_id IS NOT NULL)",
                        name="paid_link"),
        Index("ix_payment_occurrences_user_due", "user_id", "due_on"),
    )


class AuditEvent(Identity, Owned, Base):
    __tablename__ = "audit_events"
    entity_type: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[UUID] = mapped_column(Uuid)
    action: Mapped[str] = mapped_column(String(64))
    changes: Mapped[dict] = mapped_column(JSONB, nullable=False)
    __table_args__ = (Index("ix_audit_events_user_entity", "user_id", "entity_type", "entity_id"),)


class IdempotencyRecord(Identity, Owned, Base):
    __tablename__ = "idempotency_records"
    key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    response_status: Mapped[int] = mapped_column(Integer)
    response_body: Mapped[dict] = mapped_column(JSONB)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        UniqueConstraint("user_id", "key", name="uq_idempotency_records_owner_key"),
        CheckConstraint("length(key) > 0", name="key"),
        CheckConstraint("response_status BETWEEN 100 AND 599", name="status"),
        Index("ix_idempotency_records_expires_at", "expires_at"),
    )


class SavingsGoal(Identity, Owned, Versioned, Base):
    __tablename__ = "savings_goals"
    name: Mapped[str] = mapped_column(String(120))
    currency: Mapped[str] = mapped_column(String(3), ForeignKey("currencies.code", ondelete="RESTRICT"))
    target_minor: Mapped[int] = mapped_column(BigInteger)
    mode: Mapped[str] = mapped_column(String(12))
    manual_minor: Mapped[int | None] = mapped_column(BigInteger)
    deadline: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(12), server_default="active")
    archived_progress_minor: Mapped[int | None] = mapped_column(BigInteger)
    __table_args__ = (
        UniqueConstraint("user_id", "id", "currency", name="uq_savings_goals_owner_currency"),
        CheckConstraint("length(trim(name)) > 0", name="name"),
        CheckConstraint("target_minor > 0 AND target_minor <= 9000000000000000", name="target"),
        CheckConstraint("(mode = 'manual' AND manual_minor IS NOT NULL AND manual_minor >= 0 AND manual_minor <= 9000000000000000) OR (mode = 'linked' AND manual_minor IS NULL)", name="mode"),
        CheckConstraint("status IN ('active', 'completed', 'archived')", name="status"),
        CheckConstraint("version > 0", name="version"),
        Index("ix_savings_goals_user_id", "user_id"),
    )


class GoalAllocation(Identity, Owned, Base):
    __tablename__ = "goal_allocations"
    goal_id: Mapped[UUID] = mapped_column(Uuid)
    account_id: Mapped[UUID] = mapped_column(Uuid)
    currency: Mapped[str] = mapped_column(String(3))
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    __table_args__ = (
        UniqueConstraint("goal_id", "account_id", name="uq_goal_allocations_goal_account"),
        ForeignKeyConstraint(["user_id", "goal_id", "currency"], ["savings_goals.user_id", "savings_goals.id", "savings_goals.currency"], name="fk_goal_allocations_goal", ondelete="RESTRICT"),
        ForeignKeyConstraint(["user_id", "account_id", "currency"], ["accounts.user_id", "accounts.id", "accounts.currency"], name="fk_goal_allocations_account", ondelete="RESTRICT"),
        CheckConstraint("amount_minor > 0 AND amount_minor <= 9000000000000000", name="amount"),
        Index("ix_goal_allocations_user_id", "user_id"),
    )


class DepositPlanVersion(Identity, Owned, Versioned, Base):
    __tablename__ = "deposit_plan_versions"
    account_id: Mapped[UUID] = mapped_column(Uuid)
    currency: Mapped[str] = mapped_column(String(3))
    effective_month: Mapped[date] = mapped_column(Date)
    amount_minor: Mapped[int | None] = mapped_column(BigInteger)
    __table_args__ = (
        UniqueConstraint("account_id", "effective_month", name="uq_deposit_plan_versions_account_month"),
        ForeignKeyConstraint(["user_id", "account_id", "currency"], ["accounts.user_id", "accounts.id", "accounts.currency"], name="fk_deposit_plan_versions_account", ondelete="RESTRICT"),
        CheckConstraint("amount_minor > 0 AND amount_minor <= 9000000000000000", name="amount"),
        CheckConstraint("extract(day FROM effective_month) = 1", name="month"),
        CheckConstraint("version > 0", name="version"),
        Index("ix_deposit_plan_versions_user_id", "user_id"),
    )
