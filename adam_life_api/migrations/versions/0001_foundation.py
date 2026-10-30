"""Initial tenant-safe financial persistence foundation. No demo data.

Revision ID: 0001_foundation
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001_foundation"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('currencies',
    sa.Column('code', sa.String(length=3), nullable=False),
    sa.Column('minor_unit_digits', sa.Integer(), nullable=False),
    sa.CheckConstraint("code IN ('KZT', 'USD', 'EUR')", name=op.f('ck_currencies_supported_code')),
    sa.CheckConstraint('minor_unit_digits = 2', name=op.f('ck_currencies_minor_digits')),
    sa.PrimaryKeyConstraint('code', name=op.f('pk_currencies'))
    )
    op.create_table('users',
    sa.Column('google_sub', sa.String(length=255), nullable=True),
    sa.Column('email', sa.String(length=320), nullable=True),
    sa.Column('display_name', sa.String(length=200), nullable=False),
    sa.Column('timezone', sa.String(length=64), server_default='Asia/Qyzylorda', nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_users')),
    sa.UniqueConstraint('google_sub', name=op.f('uq_users_google_sub'))
    )
    op.create_table('accounts',
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('kind', sa.String(length=12), nullable=False),
    sa.Column('bank_code', sa.String(length=40), nullable=True),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('opening_balance_minor', sa.BigInteger(), nullable=False),
    sa.Column('opening_date', sa.Date(), nullable=False),
    sa.Column('archived_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('version', sa.Integer(), server_default=sa.text('1'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("kind IN ('bank', 'cash')", name=op.f('ck_accounts_kind')),
    sa.CheckConstraint('length(trim(name)) > 0', name=op.f('ck_accounts_name')),
    sa.CheckConstraint('version > 0', name=op.f('ck_accounts_version')),
    sa.ForeignKeyConstraint(['currency'], ['currencies.code'], name=op.f('fk_accounts_currency_currencies'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_accounts_user_id_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_accounts')),
    sa.UniqueConstraint('user_id', 'id', 'currency', name='uq_accounts_owner_id_currency'),
    sa.UniqueConstraint('user_id', 'id', name='uq_accounts_owner_id')
    )
    op.create_index('ix_accounts_user_id', 'accounts', ['user_id'], unique=False)
    op.create_table('audit_events',
    sa.Column('entity_type', sa.String(length=64), nullable=False),
    sa.Column('entity_id', sa.Uuid(), nullable=False),
    sa.Column('action', sa.String(length=64), nullable=False),
    sa.Column('changes', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_audit_events_user_id_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_audit_events'))
    )
    op.create_index('ix_audit_events_user_entity', 'audit_events', ['user_id', 'entity_type', 'entity_id'], unique=False)
    op.create_table('categories',
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('kind', sa.String(length=12), nullable=False),
    sa.Column('sort_order', sa.Integer(), server_default=sa.text('0'), nullable=False),
    sa.Column('archived_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('version', sa.Integer(), server_default=sa.text('1'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("kind IN ('income', 'expense')", name=op.f('ck_categories_kind')),
    sa.CheckConstraint('length(trim(name)) > 0', name=op.f('ck_categories_name')),
    sa.CheckConstraint('version > 0', name=op.f('ck_categories_version')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_categories_user_id_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_categories')),
    sa.UniqueConstraint('user_id', 'id', 'kind', name='uq_categories_owner_id_kind')
    )
    op.create_index('ix_categories_user_id', 'categories', ['user_id'], unique=False)
    op.create_table('idempotency_records',
    sa.Column('key', sa.String(length=128), nullable=False),
    sa.Column('request_hash', sa.String(length=64), nullable=False),
    sa.Column('response_status', sa.Integer(), nullable=False),
    sa.Column('response_body', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.CheckConstraint('length(key) > 0', name=op.f('ck_idempotency_records_key')),
    sa.CheckConstraint('response_status BETWEEN 100 AND 599', name=op.f('ck_idempotency_records_status')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_idempotency_records_user_id_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_idempotency_records')),
    sa.UniqueConstraint('user_id', 'key', name='uq_idempotency_records_owner_key')
    )
    op.create_index('ix_idempotency_records_expires_at', 'idempotency_records', ['expires_at'], unique=False)
    op.create_table('payment_schedules',
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('account_id', sa.Uuid(), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('amount_minor', sa.BigInteger(), nullable=False),
    sa.Column('frequency', sa.String(length=12), nullable=False),
    sa.Column('starts_on', sa.Date(), nullable=False),
    sa.Column('ends_on', sa.Date(), nullable=True),
    sa.Column('day_of_month', sa.Integer(), nullable=True),
    sa.Column('active', sa.Boolean(), server_default=sa.text('true'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('version', sa.Integer(), server_default=sa.text('1'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("(frequency = 'once' AND day_of_month IS NULL) OR (frequency = 'monthly' AND day_of_month IS NOT NULL AND day_of_month BETWEEN 1 AND 31)", name=op.f('ck_payment_schedules_frequency')),
    sa.CheckConstraint('amount_minor > 0', name=op.f('ck_payment_schedules_positive_amount')),
    sa.CheckConstraint('ends_on IS NULL OR ends_on >= starts_on', name=op.f('ck_payment_schedules_date_range')),
    sa.CheckConstraint('length(trim(title)) > 0', name=op.f('ck_payment_schedules_title')),
    sa.CheckConstraint('version > 0', name=op.f('ck_payment_schedules_version')),
    sa.ForeignKeyConstraint(['user_id', 'account_id', 'currency'], ['accounts.user_id', 'accounts.id', 'accounts.currency'], name='fk_payment_schedules_account', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_payment_schedules_user_id_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_payment_schedules')),
    sa.UniqueConstraint('user_id', 'id', name='uq_payment_schedules_owner_id')
    )
    op.create_index('ix_payment_schedules_user_id', 'payment_schedules', ['user_id'], unique=False)
    op.create_table('transactions',
    sa.Column('kind', sa.String(length=12), nullable=False),
    sa.Column('occurred_on', sa.Date(), nullable=False),
    sa.Column('source_account_id', sa.Uuid(), nullable=True),
    sa.Column('source_currency', sa.String(length=3), nullable=True),
    sa.Column('source_amount_minor', sa.BigInteger(), nullable=True),
    sa.Column('destination_account_id', sa.Uuid(), nullable=True),
    sa.Column('destination_currency', sa.String(length=3), nullable=True),
    sa.Column('destination_amount_minor', sa.BigInteger(), nullable=True),
    sa.Column('category_id', sa.Uuid(), nullable=True),
    sa.Column('comment', sa.Text(), nullable=True),
    sa.Column('source', sa.String(length=12), server_default='manual', nullable=False),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('version', sa.Integer(), server_default=sa.text('1'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("\n            (kind = 'income' AND source_account_id IS NULL AND source_currency IS NULL\n             AND source_amount_minor IS NULL AND destination_account_id IS NOT NULL\n             AND destination_currency IS NOT NULL AND destination_amount_minor IS NOT NULL\n             AND category_id IS NOT NULL)\n            OR (kind = 'expense' AND destination_account_id IS NULL AND destination_currency IS NULL\n             AND destination_amount_minor IS NULL AND source_account_id IS NOT NULL\n             AND source_currency IS NOT NULL AND source_amount_minor IS NOT NULL AND category_id IS NOT NULL)\n            OR (kind = 'transfer' AND source_account_id IS NOT NULL AND source_currency IS NOT NULL\n             AND source_amount_minor IS NOT NULL AND destination_account_id IS NOT NULL\n             AND destination_currency IS NOT NULL AND destination_amount_minor IS NOT NULL AND category_id IS NULL)\n        ", name=op.f('ck_transactions_shape')),
    sa.CheckConstraint("kind <> 'transfer' OR source_currency <> destination_currency OR source_amount_minor = destination_amount_minor", name=op.f('ck_transactions_same_currency_transfer')),
    sa.CheckConstraint("kind IN ('income', 'expense', 'transfer')", name=op.f('ck_transactions_kind')),
    sa.CheckConstraint("source IN ('manual', 'import')", name=op.f('ck_transactions_source')),
    sa.CheckConstraint('destination_amount_minor IS NULL OR destination_amount_minor > 0', name=op.f('ck_transactions_destination_positive')),
    sa.CheckConstraint('source_account_id IS NULL OR destination_account_id IS NULL OR source_account_id <> destination_account_id', name=op.f('ck_transactions_different_accounts')),
    sa.CheckConstraint('source_amount_minor IS NULL OR source_amount_minor > 0', name=op.f('ck_transactions_source_positive')),
    sa.CheckConstraint('version > 0', name=op.f('ck_transactions_version')),
    sa.ForeignKeyConstraint(['user_id', 'category_id', 'kind'], ['categories.user_id', 'categories.id', 'categories.kind'], name='fk_transactions_category', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['user_id', 'destination_account_id', 'destination_currency'], ['accounts.user_id', 'accounts.id', 'accounts.currency'], name='fk_transactions_destination_account', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['user_id', 'source_account_id', 'source_currency'], ['accounts.user_id', 'accounts.id', 'accounts.currency'], name='fk_transactions_source_account', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_transactions_user_id_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_transactions')),
    sa.UniqueConstraint('user_id', 'id', 'kind', 'source_account_id', 'source_currency', 'source_amount_minor', name='uq_transactions_payment_link'),
    sa.UniqueConstraint('user_id', 'id', name='uq_transactions_owner_id')
    )
    op.create_index('ix_transactions_user_date', 'transactions', ['user_id', 'occurred_on', 'id'], unique=False)
    op.create_index('ix_transactions_user_destination', 'transactions', ['user_id', 'destination_account_id'], unique=False)
    op.create_index('ix_transactions_user_source', 'transactions', ['user_id', 'source_account_id'], unique=False)
    op.create_table('payment_occurrences',
    sa.Column('schedule_id', sa.Uuid(), nullable=False),
    sa.Column('period_start', sa.Date(), nullable=False),
    sa.Column('due_on', sa.Date(), nullable=False),
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('account_id', sa.Uuid(), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('amount_minor', sa.BigInteger(), nullable=False),
    sa.Column('paid_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('transaction_id', sa.Uuid(), nullable=True),
    sa.Column('transaction_kind', sa.String(length=12), server_default='expense', nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('version', sa.Integer(), server_default=sa.text('1'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("transaction_kind = 'expense'", name=op.f('ck_payment_occurrences_expense_only')),
    sa.CheckConstraint('(paid_at IS NULL AND transaction_id IS NULL) OR (paid_at IS NOT NULL AND transaction_id IS NOT NULL)', name=op.f('ck_payment_occurrences_paid_link')),
    sa.CheckConstraint('amount_minor > 0', name=op.f('ck_payment_occurrences_positive_amount')),
    sa.CheckConstraint('length(trim(title)) > 0', name=op.f('ck_payment_occurrences_title')),
    sa.CheckConstraint('version > 0', name=op.f('ck_payment_occurrences_version')),
    sa.ForeignKeyConstraint(['user_id', 'account_id', 'currency'], ['accounts.user_id', 'accounts.id', 'accounts.currency'], name='fk_payment_occurrences_account', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['user_id', 'schedule_id'], ['payment_schedules.user_id', 'payment_schedules.id'], name='fk_payment_occurrences_schedule', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['user_id', 'transaction_id', 'transaction_kind', 'account_id', 'currency', 'amount_minor'], ['transactions.user_id', 'transactions.id', 'transactions.kind', 'transactions.source_account_id', 'transactions.source_currency', 'transactions.source_amount_minor'], name='fk_payment_occurrences_expense', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_payment_occurrences_user_id_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_payment_occurrences')),
    sa.UniqueConstraint('user_id', 'schedule_id', 'period_start', name='uq_payment_occurrences_period'),
    sa.UniqueConstraint('user_id', 'transaction_id', name='uq_payment_occurrences_transaction')
    )
    op.create_index('ix_payment_occurrences_user_due', 'payment_occurrences', ['user_id', 'due_on'], unique=False)
    # Reference data only. No users, demo accounts, or financial operations.
    op.bulk_insert(sa.table('currencies', sa.column('code', sa.String), sa.column('minor_unit_digits', sa.Integer)),
                   [{'code': 'KZT', 'minor_unit_digits': 2}, {'code': 'USD', 'minor_unit_digits': 2},
                    {'code': 'EUR', 'minor_unit_digits': 2}])


def downgrade() -> None:
    op.drop_table("payment_occurrences")
    op.drop_table("transactions")
    op.drop_table("payment_schedules")
    op.drop_table("idempotency_records")
    op.drop_table("audit_events")
    op.drop_table("categories")
    op.drop_table("accounts")
    op.drop_table("users")
    op.drop_table("currencies")

