"""Allow deposit accounts; preserve all existing rows, RLS and triggers."""
from alembic import op
import sqlalchemy as sa

revision = "0004_finance"
down_revision = "0003_auth"
branch_labels = depends_on = None


def upgrade():
    op.drop_constraint(op.f("ck_accounts_kind"), "accounts", type_="check")
    op.create_check_constraint("kind", "accounts", "kind IN ('bank', 'cash', 'deposit')")


def downgrade():
    # Fail rather than silently relabel or delete a user's deposits.
    op.execute(sa.text("""DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM accounts WHERE kind = 'deposit') THEN
            RAISE EXCEPTION 'Cannot downgrade while deposit accounts exist';
        END IF;
    END $$"""))
    op.drop_constraint(op.f("ck_accounts_kind"), "accounts", type_="check")
    op.create_check_constraint("kind", "accounts", "kind IN ('bank', 'cash')")
