"""Tenant isolation and opening-balance safeguards.

Revision ID: 0002_tenant_guards
"""
from alembic import op

revision = "0002_tenant_guards"
down_revision = "0001_foundation"
branch_labels = None
depends_on = None

TENANT_TABLES = (
    "users", "accounts", "categories", "transactions", "payment_schedules",
    "payment_occurrences", "audit_events", "idempotency_records",
)


def upgrade() -> None:
    for table in TENANT_TABLES:
        owner = "id" if table == "users" else "user_id"
        predicate = f"{owner} = nullif(current_setting('app.user_id', true), '')::uuid"
        op.execute(f'ALTER TABLE {table} ENABLE ROW LEVEL SECURITY')
        op.execute(f'ALTER TABLE {table} FORCE ROW LEVEL SECURITY')
        if table == "audit_events":
            op.execute(f'CREATE POLICY tenant_read ON {table} FOR SELECT USING ({predicate})')
            op.execute(f'CREATE POLICY tenant_insert ON {table} FOR INSERT WITH CHECK ({predicate})')
        else:
            op.execute(f'CREATE POLICY tenant_owner ON {table} USING ({predicate}) WITH CHECK ({predicate})')

    op.execute("""
        CREATE FUNCTION guard_transaction_opening_date() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
        DECLARE account_row record;
        BEGIN
            -- Consistent lock order for a two-account transfer. Serialize against
            -- concurrent opening-date edits; both guards see committed changes.
            FOR account_row IN
                SELECT id, opening_date FROM public.accounts
                WHERE user_id = NEW.user_id
                  AND id IN (NEW.source_account_id, NEW.destination_account_id)
                ORDER BY id FOR SHARE
            LOOP
                IF NEW.occurred_on < account_row.opening_date THEN
                    RAISE EXCEPTION 'Operation predates account opening boundary'
                        USING ERRCODE = '23514';
                END IF;
            END LOOP;
            RETURN NEW;
        END; $$
    """)
    op.execute("""
        CREATE TRIGGER transactions_opening_boundary
        BEFORE INSERT OR UPDATE ON transactions
        FOR EACH ROW EXECUTE FUNCTION guard_transaction_opening_date()
    """)
    op.execute("""
        CREATE FUNCTION guard_account_baseline() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
        BEGIN
            IF NEW.currency IS DISTINCT FROM OLD.currency THEN
                RAISE EXCEPTION 'Account currency is immutable; use a separate account'
                    USING ERRCODE = '23514';
            END IF;
            IF NEW.opening_balance_minor IS DISTINCT FROM OLD.opening_balance_minor
               OR NEW.opening_date IS DISTINCT FROM OLD.opening_date THEN
                IF NEW.version <> OLD.version + 1 THEN
                    RAISE EXCEPTION 'Opening changes require next account version'
                        USING ERRCODE = '23514';
                END IF;
                IF EXISTS (
                    SELECT 1 FROM public.transactions
                    WHERE user_id = OLD.user_id AND occurred_on < NEW.opening_date
                      AND (source_account_id = OLD.id OR destination_account_id = OLD.id)
                ) THEN
                    RAISE EXCEPTION 'Opening boundary would exclude recorded history'
                        USING ERRCODE = '23514';
                END IF;
                INSERT INTO public.audit_events (id, user_id, entity_type, entity_id, action, changes)
                VALUES (gen_random_uuid(), OLD.user_id, 'account', OLD.id, 'opening_changed',
                    jsonb_build_object(
                        'old', jsonb_build_object('opening_date', OLD.opening_date,
                            'opening_balance_minor', OLD.opening_balance_minor::text, 'version', OLD.version),
                        'new', jsonb_build_object('opening_date', NEW.opening_date,
                            'opening_balance_minor', NEW.opening_balance_minor::text, 'version', NEW.version)));
                NEW.updated_at = now();
            END IF;
            RETURN NEW;
        END; $$
    """)
    op.execute("""
        CREATE TRIGGER accounts_baseline_guard
        BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION guard_account_baseline()
    """)
    op.execute("""
        CREATE FUNCTION forbid_audit_mutation() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
        BEGIN
            RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE = '23514';
        END; $$
    """)
    op.execute("""
        CREATE TRIGGER audit_events_append_only
        BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation()
    """)


def downgrade() -> None:
    op.execute('DROP TRIGGER audit_events_append_only ON audit_events')
    op.execute('DROP FUNCTION forbid_audit_mutation()')
    op.execute('DROP TRIGGER accounts_baseline_guard ON accounts')
    op.execute('DROP FUNCTION guard_account_baseline()')
    op.execute('DROP TRIGGER transactions_opening_boundary ON transactions')
    op.execute('DROP FUNCTION guard_transaction_opening_date()')
    for table in reversed(TENANT_TABLES):
        if table == "audit_events":
            op.execute(f'DROP POLICY tenant_read ON {table}')
            op.execute(f'DROP POLICY tenant_insert ON {table}')
        else:
            op.execute(f'DROP POLICY tenant_owner ON {table}')
        op.execute(f'ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY')
        op.execute(f'ALTER TABLE {table} DISABLE ROW LEVEL SECURITY')
