"""busca sem acento: extensão unaccent + wrapper public.sispat_unaccent(text)

NAO aplicada em producao (aguarda autorizacao). Espelho SQL:
backend/migrations/sql/0017_unaccent_search.sql. Aditiva e idempotente.
O backend (`app.security.text_search`) passa a depender da função: aplicar
ANTES do deploy do backend.

Revision ID: 0014_unaccent_search
Revises: 0013_dashboard_layout_prefs
Create Date: 2026-10-21
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0014_unaccent_search"
down_revision: Union[str, None] = "0013_dashboard_layout_prefs"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

UP_SQL = """
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE OR REPLACE FUNCTION public.sispat_unaccent(input text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
SET search_path = public, extensions
AS $$ SELECT unaccent($1) $$;
"""


def upgrade() -> None:
    op.execute(UP_SQL)


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS public.sispat_unaccent(text)")
