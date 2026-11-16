"""Kaspi import evidence, user rules and non-earning adjustments. Additive only."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = '0007_kaspi'
down_revision = '0006_savings'
branch_labels = depends_on = None


def identity(versioned=False):
    values = [sa.Column('id', sa.Uuid(), primary_key=True), sa.Column('user_id', sa.Uuid(), sa.ForeignKey('users.id', ondelete='RESTRICT'), nullable=False), sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False)]
    if versioned:
        values += [sa.Column('version', sa.Integer(), nullable=False, server_default=sa.text('1')), sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())]
    return values


def baseline_guard(active_only):
    # Tombstones keep the audit trail, but must not prevent an atomic import undo.
    condition = 'AND deleted_at IS NULL' if active_only else ''
    op.execute(f"""CREATE OR REPLACE FUNCTION guard_account_baseline() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN
      IF NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION 'Account currency is immutable; use a separate account' USING ERRCODE = '23514';
      END IF;
      IF NEW.opening_balance_minor IS DISTINCT FROM OLD.opening_balance_minor OR NEW.opening_date IS DISTINCT FROM OLD.opening_date THEN
        IF NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'Opening changes require next account version' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (SELECT 1 FROM public.transactions WHERE user_id = OLD.user_id AND occurred_on < NEW.opening_date
          {condition} AND (source_account_id = OLD.id OR destination_account_id = OLD.id)) THEN
          RAISE EXCEPTION 'Opening boundary would exclude recorded history' USING ERRCODE = '23514';
        END IF;
        INSERT INTO public.audit_events (id, user_id, entity_type, entity_id, action, changes)
        VALUES (gen_random_uuid(), OLD.user_id, 'account', OLD.id, 'opening_changed', jsonb_build_object(
          'old', jsonb_build_object('opening_date', OLD.opening_date, 'opening_balance_minor', OLD.opening_balance_minor::text, 'version', OLD.version),
          'new', jsonb_build_object('opening_date', NEW.opening_date, 'opening_balance_minor', NEW.opening_balance_minor::text, 'version', NEW.version)));
        NEW.updated_at = now();
      END IF;
      RETURN NEW;
    END; $$""")


def upgrade():
    baseline_guard(True)
    op.add_column('transactions', sa.Column('adjustment_type', sa.String(20)))
    op.add_column('transactions', sa.Column('related_transaction_id', sa.Uuid()))
    op.create_foreign_key('fk_transactions_adjustment', 'transactions', 'transactions', ['user_id', 'related_transaction_id'], ['user_id', 'id'], ondelete='RESTRICT')
    op.create_check_constraint('adjustment_type', 'transactions', "adjustment_type IN ('refund', 'reversal', 'fx', 'return_funds') AND kind <> 'transfer' OR adjustment_type IS NULL")
    op.create_check_constraint('adjustment_link', 'transactions', 'related_transaction_id IS NULL OR (adjustment_type IS NOT NULL AND related_transaction_id <> id)')
    op.create_table('import_batches', *identity(),
        sa.Column('status', sa.String(12), nullable=False), sa.Column('file_hash', sa.String(64), nullable=False),
        sa.Column('bank_digest', sa.String(64), nullable=False), sa.Column('account_id', sa.Uuid()),
        sa.Column('payload', JSONB, nullable=False), sa.Column('result', JSONB, nullable=False), sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint('user_id', 'id', name='uq_import_batches_owner_id'),
        sa.ForeignKeyConstraint(['user_id', 'account_id'], ['accounts.user_id', 'accounts.id'], name='fk_import_batches_account', ondelete='RESTRICT'),
        sa.CheckConstraint("status IN ('draft', 'committed', 'cancelled', 'undone')", name='status'))
    op.create_table('bank_bindings', *identity(), sa.Column('bank_digest', sa.String(64), nullable=False), sa.Column('account_id', sa.Uuid(), nullable=False), sa.Column('last_four', sa.String(4), nullable=False),
        sa.UniqueConstraint('user_id', 'bank_digest', name='uq_bank_bindings_digest'), sa.UniqueConstraint('user_id', 'account_id', name='uq_bank_bindings_account'),
        sa.ForeignKeyConstraint(['user_id', 'account_id'], ['accounts.user_id', 'accounts.id'], name='fk_bank_bindings_account', ondelete='RESTRICT'))
    op.create_table('import_rules', *identity(True), sa.Column('key', sa.String(1000), nullable=False), sa.Column('original', sa.String(1000), nullable=False), sa.Column('rule_type', sa.String(12), nullable=False), sa.Column('category_id', sa.Uuid()), sa.Column('category_kind', sa.String(12)), sa.Column('account_id', sa.Uuid()),
        sa.UniqueConstraint('user_id', 'key', 'rule_type', name='uq_import_rules_key'),
        sa.ForeignKeyConstraint(['user_id', 'category_id', 'category_kind'], ['categories.user_id', 'categories.id', 'categories.kind'], name='fk_import_rules_category', ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['user_id', 'account_id'], ['accounts.user_id', 'accounts.id'], name='fk_import_rules_account', ondelete='RESTRICT'),
        sa.CheckConstraint("(rule_type = 'category' AND category_id IS NOT NULL AND category_kind IS NOT NULL AND account_id IS NULL) OR (rule_type = 'own_account' AND account_id IS NOT NULL AND category_id IS NULL AND category_kind IS NULL)", name='shape'))
    op.create_table('import_movements', *identity(), sa.Column('bank_digest', sa.String(64), nullable=False), sa.Column('fingerprint', sa.String(64), nullable=False), sa.Column('ordinal', sa.Integer(), nullable=False), sa.Column('batch_id', sa.Uuid(), nullable=False), sa.Column('transaction_id', sa.Uuid(), nullable=False),
        sa.UniqueConstraint('user_id', 'bank_digest', 'fingerprint', 'ordinal', name='uq_import_movements_occurrence'),
        sa.ForeignKeyConstraint(['user_id', 'batch_id'], ['import_batches.user_id', 'import_batches.id'], name='fk_import_movements_batch', ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['user_id', 'transaction_id'], ['transactions.user_id', 'transactions.id'], name='fk_import_movements_transaction', ondelete='RESTRICT'), sa.CheckConstraint('ordinal > 0', name='ordinal'))
    for table in ('import_batches', 'import_rules', 'import_movements', 'bank_bindings'):
        if table != 'bank_bindings':
            op.create_index('ix_' + table + '_user_id', table, ['user_id'])
        op.execute(f'ALTER TABLE {table} ENABLE ROW LEVEL SECURITY')
        op.execute(f'ALTER TABLE {table} FORCE ROW LEVEL SECURITY')
        condition = "user_id = nullif(current_setting('app.user_id', true), '')::uuid"
        op.execute(f'CREATE POLICY tenant_isolation ON {table} USING ({condition}) WITH CHECK ({condition})')


def downgrade():
    # Never silently discard import evidence in a populated database.
    op.execute("DO $$ BEGIN IF EXISTS (SELECT 1 FROM import_batches) OR EXISTS (SELECT 1 FROM transactions WHERE adjustment_type IS NOT NULL) THEN RAISE EXCEPTION 'Cannot downgrade populated import data'; END IF; END $$")
    for table in ('import_movements', 'import_rules', 'bank_bindings', 'import_batches'):
        op.drop_table(table)
    op.drop_constraint('fk_transactions_adjustment', 'transactions', type_='foreignkey')
    op.drop_constraint(op.f('ck_transactions_adjustment_link'), 'transactions', type_='check')
    op.drop_constraint(op.f('ck_transactions_adjustment_type'), 'transactions', type_='check')
    op.drop_column('transactions', 'related_transaction_id')
    op.drop_column('transactions', 'adjustment_type')
    baseline_guard(False)
