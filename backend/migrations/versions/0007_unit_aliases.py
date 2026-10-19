"""tabela unit_aliases (siglas de unidade da planilha -> units)

PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. Esta migração NÃO foi
aplicada em banco algum. Depende de 0006_email_settings_permission.

A planilha de origem traz a coluna UNIDADE como sigla (ex.: `UEA`), não como
`units.name`. `unit_aliases` mapeia sigla -> unidade, sem hardcode no código.

Aditiva e idempotente:
1. `unit_aliases` (id, alias, unit_id FK units ON DELETE RESTRICT, created_at,
   created_by). Unicidade case-insensitive em lower(alias); CHECK de tamanho
   1..32 e sem espaços nas pontas.
2. RLS habilitado SEM políticas (deny-all) e REVOKE de anon/authenticated.
3. Seed de 4 aliases: PF->023401, PU->023402, CJU->023403, UEA->023404
   (pelo code da unidade; unidade inexistente é ignorada, sem falha).

Espelho SQL: backend/migrations/sql/0010_unit_aliases.sql (verificado por
backend/tests/test_db_static.py).

Downgrade: remove apenas a tabela `unit_aliases`.

Revision ID: 0007_unit_aliases
Revises: 0006_email_settings_permission
Create Date: 2026-10-16

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0007_unit_aliases"
down_revision: Union[str, None] = "0006_email_settings_permission"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

NEW_TABLES: tuple[str, ...] = ("unit_aliases",)

CREATE_UNIT_ALIASES_SQL = """
CREATE TABLE IF NOT EXISTS public.unit_aliases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alias text NOT NULL,
    unit_id uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT ck_unit_aliases_alias_length CHECK (char_length(alias) BETWEEN 1 AND 32),
    CONSTRAINT ck_unit_aliases_alias_trimmed CHECK (alias = btrim(alias))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_unit_aliases_alias_lower
    ON public.unit_aliases (lower(alias));

CREATE INDEX IF NOT EXISTS ix_unit_aliases_unit_id
    ON public.unit_aliases (unit_id);

COMMENT ON TABLE public.unit_aliases IS
    'Siglas de unidade usadas na planilha de origem (coluna UNIDADE) -> units. Unicidade case-insensitive.';
"""

ENABLE_RLS_NEW_TABLES_SQL = """
ALTER TABLE public.unit_aliases ENABLE ROW LEVEL SECURITY;
"""

REVOKE_API_ROLES_NEW_TABLES_SQL = """
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public.unit_aliases FROM anon, authenticated;
    END IF;
END
$do$;
"""

SEED_ALIASES_SQL = """
INSERT INTO public.unit_aliases (alias, unit_id)
SELECT v.alias, u.id
FROM (VALUES ('PF', '023401'), ('PU', '023402'), ('CJU', '023403'), ('UEA', '023404')) AS v(alias, code)
JOIN public.units u ON u.code = v.code
ON CONFLICT DO NOTHING;
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (
    CREATE_UNIT_ALIASES_SQL,
    ENABLE_RLS_NEW_TABLES_SQL,
    REVOKE_API_ROLES_NEW_TABLES_SQL,
    SEED_ALIASES_SQL,
)

DOWNGRADE_SQL = """
DROP TABLE IF EXISTS public.unit_aliases;
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
