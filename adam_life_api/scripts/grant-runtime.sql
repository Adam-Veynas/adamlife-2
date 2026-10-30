-- Run as adamlife_migrator while connected to the dedicated adamlife database,
-- AFTER `python -m alembic upgrade head`. Never grant ownership or migration-role membership.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO adamlife_app;
GRANT SELECT ON currencies, alembic_version TO adamlife_app;
GRANT SELECT, INSERT, UPDATE ON users TO adamlife_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    accounts, categories, transactions, payment_schedules, payment_occurrences, idempotency_records
    TO adamlife_app;
GRANT SELECT, INSERT ON audit_events TO adamlife_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON login_flows, auth_sessions TO adamlife_app;
GRANT EXECUTE ON FUNCTION guard_transaction_opening_date(), guard_account_baseline(), forbid_audit_mutation()
    TO adamlife_app;
-- Future migrations must grant only the privileges needed by new objects.
