"""Add optional deposit metadata without altering balances, history or legacy accounts."""
from alembic import op
import sqlalchemy as sa

revision = "0005_deposit"
down_revision = "0004_finance"
branch_labels = depends_on = None


def upgrade():
    op.add_column("accounts", sa.Column("deposit_type", sa.String(12), nullable=True))
    op.add_column("accounts", sa.Column("annual_rate", sa.Numeric(9, 4), nullable=True))
    op.add_column("accounts", sa.Column("deposit_opened_on", sa.Date(), nullable=True))
    op.add_column("accounts", sa.Column("deposit_ends_on", sa.Date(), nullable=True))
    op.create_check_constraint("deposit_type", "accounts", "deposit_type IN ('savings', 'term')")
    op.create_check_constraint("annual_rate", "accounts", "annual_rate >= 0 AND annual_rate <= 99999.9999")
    op.create_check_constraint("deposit_dates", "accounts", "deposit_ends_on >= deposit_opened_on")


def downgrade():
    # Explicit downgrade removes these metadata fields; never run against user data without a backup.
    for name in ("deposit_dates", "annual_rate", "deposit_type"):
        op.drop_constraint(op.f("ck_accounts_" + name), "accounts", type_="check")
    for name in ("deposit_ends_on", "deposit_opened_on", "annual_rate", "deposit_type"):
        op.drop_column("accounts", name)
