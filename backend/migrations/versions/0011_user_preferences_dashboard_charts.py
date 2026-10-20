"""user_preferences.dashboard_charts (preferência de gráficos do dashboard)

APLICADA manualmente no Supabase (projeto único) em 2026-10-19, com
autorização explícita, via o espelho sql/0014; no deploy usar
`alembic stamp 0011_user_preferences_dashboard_charts` (sem upgrade). Depende de
0010_seed_permission_corrections (a cadeia Alembic é linear).

Aditiva e idempotente: adiciona a `user_preferences` a coluna
`dashboard_charts jsonb NOT NULL DEFAULT '{}'::jsonb`, com dois CHECKs:
- ck_user_preferences_dashboard_charts_object: jsonb_typeof = 'object';
- ck_user_preferences_dashboard_charts_size: octet_length(texto) <= 512.
Linhas existentes recebem '{}'. Nenhum dado é removido.

Espelho SQL: backend/migrations/sql/0014_user_preferences_dashboard_charts.sql.

Downgrade: remove os dois CHECKs e a coluna (perde só esta preferência).

Revision ID: 0011_user_preferences_dashboard_charts
Revises: 0010_seed_permission_corrections
Create Date: 2026-10-19

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0011_user_preferences_dashboard_charts"
down_revision: Union[str, None] = "0010_seed_permission_corrections"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

ADD_COLUMN_SQL = """
ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS dashboard_charts jsonb NOT NULL DEFAULT '{}'::jsonb;
"""

ADD_CHECKS_SQL = """
DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_user_preferences_dashboard_charts_object'
          AND conrelid = 'public.user_preferences'::regclass
    ) THEN
        ALTER TABLE public.user_preferences
            ADD CONSTRAINT ck_user_preferences_dashboard_charts_object
            CHECK (jsonb_typeof(dashboard_charts) = 'object');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_user_preferences_dashboard_charts_size'
          AND conrelid = 'public.user_preferences'::regclass
    ) THEN
        ALTER TABLE public.user_preferences
            ADD CONSTRAINT ck_user_preferences_dashboard_charts_size
            CHECK (octet_length(dashboard_charts::text) <= 512);
    END IF;
END
$do$;
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (ADD_COLUMN_SQL, ADD_CHECKS_SQL)

DOWNGRADE_SQL = """
ALTER TABLE public.user_preferences
    DROP CONSTRAINT IF EXISTS ck_user_preferences_dashboard_charts_size;
ALTER TABLE public.user_preferences
    DROP CONSTRAINT IF EXISTS ck_user_preferences_dashboard_charts_object;
ALTER TABLE public.user_preferences
    DROP COLUMN IF EXISTS dashboard_charts;
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
