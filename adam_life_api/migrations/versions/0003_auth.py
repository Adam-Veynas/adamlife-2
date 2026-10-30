"""OIDC bootstrap policies and server-side sessions; existing finance policies stay intact."""
from alembic import op
import sqlalchemy as sa

revision = "0003_auth"
down_revision = "0002_tenant_guards"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("login_flows",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("state_hash", sa.String(64), nullable=False),
        sa.Column("nonce", sa.String(64), nullable=False),
        sa.Column("verifier", sa.String(128), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_login_flows_expires_at", "login_flows", ["expires_at"])
    op.create_table("auth_sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)))
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"])
    for table, setting in [("login_flows", "app.flow_hash"), ("auth_sessions", "app.session_hash")]:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        predicate = f"token_hash = nullif(current_setting('{setting}', true), '')"
        op.execute(f"CREATE POLICY credential_scope ON {table} USING ({predicate}) WITH CHECK ({predicate})")
    # Set only by trusted server code AFTER verifying Google's signature/claims/nonce.
    # No SECURITY DEFINER, BYPASSRLS, table ownership, or user-supplied user_id is needed.
    predicate = "google_sub = nullif(current_setting('app.google_sub', true), '')"
    for action in ["SELECT", "INSERT", "UPDATE"]:
        clauses = f"WITH CHECK ({predicate})" if action == "INSERT" else f"USING ({predicate})"
        if action == "UPDATE":
            clauses += f" WITH CHECK ({predicate})"
        op.execute(f"CREATE POLICY oidc_{action.lower()} ON users FOR {action} {clauses}")


def downgrade():
    for action in ["select", "insert", "update"]:
        op.execute(f"DROP POLICY oidc_{action} ON users")
    op.drop_table("auth_sessions")
    op.drop_table("login_flows")
