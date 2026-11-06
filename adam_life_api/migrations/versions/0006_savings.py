"""Savings allocations and effective-month deposit plans. No ledger changes."""
from alembic import op
import sqlalchemy as sa

revision = "0006_savings"
down_revision = "0005_deposit"
branch_labels = depends_on = None


def identity(versioned=False):
    columns = [sa.Column("id", sa.Uuid(), primary_key=True),
               sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
               sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)]
    if versioned:
        columns += [sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("1")),
                    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())]
    return columns


def upgrade():
    op.create_table("savings_goals", *identity(True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("currency", sa.String(3), sa.ForeignKey("currencies.code", ondelete="RESTRICT"), nullable=False),
        sa.Column("target_minor", sa.BigInteger(), nullable=False),
        sa.Column("mode", sa.String(12), nullable=False),
        sa.Column("manual_minor", sa.BigInteger()),
        sa.Column("deadline", sa.Date()),
        sa.Column("status", sa.String(12), nullable=False, server_default="active"),
        sa.Column("archived_progress_minor", sa.BigInteger()),
        sa.UniqueConstraint("user_id", "id", "currency", name="uq_savings_goals_owner_currency"),
        sa.CheckConstraint("length(trim(name)) > 0", name="name"),
        sa.CheckConstraint("target_minor > 0 AND target_minor <= 9000000000000000", name="target"),
        sa.CheckConstraint("(mode = 'manual' AND manual_minor IS NOT NULL AND manual_minor >= 0 AND manual_minor <= 9000000000000000) OR (mode = 'linked' AND manual_minor IS NULL)", name="mode"),
        sa.CheckConstraint("status IN ('active', 'completed', 'archived')", name="status"),
        sa.CheckConstraint("version > 0", name="version"))
    op.create_table("goal_allocations", *identity(),
        sa.Column("goal_id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("goal_id", "account_id", name="uq_goal_allocations_goal_account"),
        sa.ForeignKeyConstraint(["user_id", "goal_id", "currency"], ["savings_goals.user_id", "savings_goals.id", "savings_goals.currency"], name="fk_goal_allocations_goal", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["user_id", "account_id", "currency"], ["accounts.user_id", "accounts.id", "accounts.currency"], name="fk_goal_allocations_account", ondelete="RESTRICT"),
        sa.CheckConstraint("amount_minor > 0 AND amount_minor <= 9000000000000000", name="amount"))
    op.create_table("deposit_plan_versions", *identity(True),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("effective_month", sa.Date(), nullable=False),
        sa.Column("amount_minor", sa.BigInteger()),
        sa.UniqueConstraint("account_id", "effective_month", name="uq_deposit_plan_versions_account_month"),
        sa.ForeignKeyConstraint(["user_id", "account_id", "currency"], ["accounts.user_id", "accounts.id", "accounts.currency"], name="fk_deposit_plan_versions_account", ondelete="RESTRICT"),
        sa.CheckConstraint("amount_minor > 0 AND amount_minor <= 9000000000000000", name="amount"),
        sa.CheckConstraint("extract(day FROM effective_month) = 1", name="month"),
        sa.CheckConstraint("version > 0", name="version"))
    for table in ("savings_goals", "goal_allocations", "deposit_plan_versions"):
        op.create_index("ix_" + table + "_user_id", table, ["user_id"])
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        condition = "user_id = nullif(current_setting('app.user_id', true), '')::uuid"
        op.execute(f"CREATE POLICY tenant_isolation ON {table} USING ({condition}) WITH CHECK ({condition})")


def downgrade():
    # Explicit rollback drops savings data. Never run against user data without a backup.
    for table in ("deposit_plan_versions", "goal_allocations", "savings_goals"):
        op.drop_table(table)
