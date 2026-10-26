"""assets: chave alfanumérica do número patrimonial para busca (função + índice trigram)

PENDENTE DE APLICAÇÃO: NÃO aplicar em banco algum sem autorização explícita
(dev = prod no Supabase). Padrão do projeto, quando autorizada: executar o
espelho sql/0019 no SQL Editor e, no deploy, `alembic stamp
0016_asset_search_key` (sem upgrade). Depende de 0014_unaccent_search
(`public.sispat_unaccent`) e de `pg_trgm` (0001).

Contexto: `/patrimonios?q=` passa a casar `AGU-123`, `12.345`, `AB 123` com
`AGU123`, `12345`, `AB-123` pela chave alfanumérica (minúsculas, sem acento,
sem pontuação/espaços/NBSP) do número patrimonial.

Aditiva e idempotente, sem alterar dados nem tabelas (RLS/REVOKE já vêm da
0004; nenhuma tabela nova):
- função `public.sispat_alnum_key(text)` IMMUTABLE (search_path fixo);
- índice GIN trigram funcional `ix_assets_patrimony_key_trgm`
  (`sispat_alnum_key(patrimony_number)`), que acelera `LIKE '%x%'`.
A consulta nova do backend CHAMA a função: aplicar ANTES do deploy do backend.

Espelho SQL: backend/migrations/sql/0019_asset_search_key.sql.
Downgrade: remove só o índice e a função criados aqui.

Revision ID: 0016_asset_search_key
Revises: 0015_asset_tech_classification
Create Date: 2026-10-26
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0016_asset_search_key"
down_revision: Union[str, None] = "0015_asset_tech_classification"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

CREATE_FUNCTION_SQL = """
CREATE OR REPLACE FUNCTION public.sispat_alnum_key(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = extensions, pg_catalog
AS $$ SELECT lower(regexp_replace(public.sispat_unaccent($1), '[^[:alnum:]]+', '', 'g')) $$;
"""

CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS ix_assets_patrimony_key_trgm
    ON public.assets USING gin (public.sispat_alnum_key(patrimony_number) gin_trgm_ops);
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (CREATE_FUNCTION_SQL, CREATE_INDEX_SQL)

DOWNGRADE_SQL = """
DROP INDEX IF EXISTS public.ix_assets_patrimony_key_trgm;
DROP FUNCTION IF EXISTS public.sispat_alnum_key(text);
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
