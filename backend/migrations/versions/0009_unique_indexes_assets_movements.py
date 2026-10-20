"""indices unicos parciais: numero patrimonial ativo e uma movimentacao PENDENTE por bem

PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. Esta migração NÃO foi
aplicada em banco algum. Depende de 0008_catalog_source_ids_perms
(que também está pendente no alembic_version do banco).

Aditiva e idempotente (SEC-AST-01 e SEC-MOV-02):
1. `uq_assets_patrimony_number_active`: unicidade de
   lower(btrim(patrimony_number)) entre bens ATIVOS (deleted_at IS NULL).
2. `uq_asset_movements_one_pending`: no máximo uma movimentação PENDENTE por
   bem (UNIQUE parcial em asset_id WHERE status = 'PENDENTE').

Antes de cada índice há uma verificação que ABORTA a migração com mensagem
clara (apenas contagem, sem número patrimonial nem dado pessoal) se existirem
duplicatas, em vez de falhar de forma opaca. Na data da escrita as tabelas de
bens e movimentações têm 0 linhas.

Espelho SQL: backend/migrations/sql/0012_unique_indexes_assets_movements.sql.

Downgrade: remove apenas os dois índices (DROP INDEX IF EXISTS).

Revision ID: 0009_uniq_idx_assets_movements
Revises: 0008_catalog_source_ids_perms
Create Date: 2026-10-17

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0009_uniq_idx_assets_movements"
down_revision: Union[str, None] = "0008_catalog_source_ids_perms"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

NEW_INDEXES: tuple[str, ...] = (
    "uq_assets_patrimony_number_active",
    "uq_asset_movements_one_pending",
)

PRECHECK_ASSETS_SQL = """
DO $do$
DECLARE
    dup_count integer;
BEGIN
    SELECT count(*) INTO dup_count FROM (
        SELECT 1 FROM public.assets
        WHERE deleted_at IS NULL
        GROUP BY lower(btrim(patrimony_number))
        HAVING count(*) > 1
    ) d;
    IF dup_count > 0 THEN
        RAISE EXCEPTION 'SEC-AST-01: % numero(s) patrimonial(is) duplicado(s) entre bens ativos; resolva antes de aplicar (nenhum indice foi criado)', dup_count;
    END IF;
END
$do$;
"""

CREATE_ASSETS_INDEX_SQL = """
CREATE UNIQUE INDEX IF NOT EXISTS uq_assets_patrimony_number_active
    ON public.assets (lower(btrim(patrimony_number))) WHERE deleted_at IS NULL;
"""

PRECHECK_MOVEMENTS_SQL = """
DO $do$
DECLARE
    dup_count integer;
BEGIN
    SELECT count(*) INTO dup_count FROM (
        SELECT 1 FROM public.asset_movements
        WHERE status = 'PENDENTE'
        GROUP BY asset_id
        HAVING count(*) > 1
    ) d;
    IF dup_count > 0 THEN
        RAISE EXCEPTION 'SEC-MOV-02: % bem(ns) com mais de uma movimentacao PENDENTE; resolva antes de aplicar (nenhum indice foi criado)', dup_count;
    END IF;
END
$do$;
"""

CREATE_MOVEMENTS_INDEX_SQL = """
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_movements_one_pending
    ON public.asset_movements (asset_id) WHERE status = 'PENDENTE';
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (
    PRECHECK_ASSETS_SQL,
    CREATE_ASSETS_INDEX_SQL,
    PRECHECK_MOVEMENTS_SQL,
    CREATE_MOVEMENTS_INDEX_SQL,
)

DOWNGRADE_SQL = """
DROP INDEX IF EXISTS public.uq_asset_movements_one_pending;
DROP INDEX IF EXISTS public.uq_assets_patrimony_number_active;
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
