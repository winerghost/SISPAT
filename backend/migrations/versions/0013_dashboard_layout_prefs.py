"""user_preferences.dashboard_layout (ordem/visibilidade dos painéis do dashboard)

APLICADA manualmente no Supabase (projeto único) em 2026-10-21, com
autorização explícita, via o espelho sql/0016; no deploy usar
`alembic stamp 0013_dashboard_layout_prefs` (sem upgrade). Depende de
0012_asset_bond_status (a cadeia Alembic é linear).

Aditiva e idempotente: adiciona a `user_preferences` a coluna
`dashboard_layout jsonb NOT NULL DEFAULT '{}'::jsonb`, com dois CHECKs:
- ck_user_preferences_dashboard_layout_object: jsonb_typeof = 'object';
- ck_user_preferences_dashboard_layout_size: octet_length(texto) <= 1024.
Linhas existentes recebem '{}' (= layout padrão). Nenhum dado é removido.
O conteúdo (`order`/`hidden` com IDs da allowlist de painéis) é validado no
backend (`app.api.v1.schemas.DashboardLayoutPatch`).

Espelho SQL: backend/migrations/sql/0016_dashboard_layout_prefs.sql.

Downgrade: remove os dois CHECKs e a coluna (perde só esta preferência).

Revision ID: 0013_dashboard_layout_prefs
Revises: 0012_asset_bond_status
Create Date: 2026-10-20

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0013_dashboard_layout_prefs"
down_revision: Union[str, None] = "0012_asset_bond_status"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

ADD_COLUMN_SQL = """
ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS dashboard_layout jsonb NOT NULL DEFAULT '{}'::jsonb;
"""

ADD_CHECKS_SQL = """
DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_user_preferences_dashboard_layout_object'
          AND conrelid = 'public.user_preferences'::regclass
    ) THEN
        ALTER TABLE public.user_preferences
            ADD CONSTRAINT ck_user_preferences_dashboard_layout_object
            CHECK (jsonb_typeof(dashboard_layout) = 'object');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_user_preferences_dashboard_layout_size'
          AND conrelid = 'public.user_preferences'::regclass
    ) THEN
        ALTER TABLE public.user_preferences
            ADD CONSTRAINT ck_user_preferences_dashboard_layout_size
            CHECK (octet_length(dashboard_layout::text) <= 1024);
    END IF;
END
$do$;
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (ADD_COLUMN_SQL, ADD_CHECKS_SQL)

DOWNGRADE_SQL = """
ALTER TABLE public.user_preferences
    DROP CONSTRAINT IF EXISTS ck_user_preferences_dashboard_layout_size;
ALTER TABLE public.user_preferences
    DROP CONSTRAINT IF EXISTS ck_user_preferences_dashboard_layout_object;
ALTER TABLE public.user_preferences
    DROP COLUMN IF EXISTS dashboard_layout;
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
