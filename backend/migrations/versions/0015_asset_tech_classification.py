"""assets: classificação de bens de TI (categoria, tipo de TI, situação operacional)

PENDENTE DE APLICAÇÃO: NÃO aplicar em banco algum sem autorização explícita
(dev = prod no Supabase). Padrão do projeto, quando autorizada: executar o
espelho sql/0018 no SQL Editor e, no deploy, `alembic stamp
0015_asset_tech_classification` (sem upgrade). Depende de 0014_unaccent_search
(a cadeia Alembic é linear).

Contexto: o cadastro de bens não distingue tecnologia de mobiliário etc.; o
"tipo" do dashboard é só inferido da descrição. Esta migração materializa a
classificação para os painéis de Tecnologia (`/api/v1/dashboard/tecnologia/*`).

Aditiva, idempotente e sem backfill (a classificação inicial é o comando
`flask classify-assets`, dry-run por padrão):
- colunas `asset_category`, `tech_type`, `operational_status` (text NULL, SEM
  default: NULL = "não informado", nunca um valor fictício);
- CHECK `ck_assets_asset_category` (TECNOLOGIA/MOBILIARIO/VEICULO/EQUIPAMENTO/OUTROS);
- CHECK `ck_assets_tech_type` (COMPUTADOR/NOTEBOOK/MONITOR/IMPRESSORA/OUTRO_TI e
  somente quando a categoria é TECNOLOGIA);
- CHECK `ck_assets_operational_status` (EM_USO/ESTOQUE/MANUTENCAO/BAIXADO);
- índice parcial `ix_assets_category_active` (bens ativos já classificados).
Tabela existente: RLS/REVOKE já vêm da 0004 (nenhuma tabela nova aqui).

Espelho SQL: backend/migrations/sql/0018_asset_tech_classification.sql.

Downgrade: remove só o que esta migração criou (índice, CHECKs e colunas;
perde apenas a classificação).

Revision ID: 0015_asset_tech_classification
Revises: 0014_unaccent_search
Create Date: 2026-10-22

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0015_asset_tech_classification"
down_revision: Union[str, None] = "0014_unaccent_search"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

ADD_COLUMNS_SQL = """
ALTER TABLE public.assets
    ADD COLUMN IF NOT EXISTS asset_category text NULL,
    ADD COLUMN IF NOT EXISTS tech_type text NULL,
    ADD COLUMN IF NOT EXISTS operational_status text NULL;
"""

ADD_CHECKS_SQL = """
DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_asset_category'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_asset_category
            CHECK (asset_category IS NULL OR asset_category IN ('TECNOLOGIA','MOBILIARIO','VEICULO','EQUIPAMENTO','OUTROS'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_tech_type'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_tech_type
            CHECK (tech_type IS NULL OR (asset_category = 'TECNOLOGIA' AND tech_type IN ('COMPUTADOR','NOTEBOOK','MONITOR','IMPRESSORA','OUTRO_TI')));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_operational_status'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_operational_status
            CHECK (operational_status IS NULL OR operational_status IN ('EM_USO','ESTOQUE','MANUTENCAO','BAIXADO'));
    END IF;
END
$do$;
"""

CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS ix_assets_category_active
    ON public.assets (asset_category, tech_type, unit_id)
    WHERE deleted_at IS NULL AND asset_category IS NOT NULL;
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (ADD_COLUMNS_SQL, ADD_CHECKS_SQL, CREATE_INDEX_SQL)

DOWNGRADE_SQL = """
DROP INDEX IF EXISTS public.ix_assets_category_active;
ALTER TABLE public.assets
    DROP CONSTRAINT IF EXISTS ck_assets_operational_status;
ALTER TABLE public.assets
    DROP CONSTRAINT IF EXISTS ck_assets_tech_type;
ALTER TABLE public.assets
    DROP CONSTRAINT IF EXISTS ck_assets_asset_category;
ALTER TABLE public.assets
    DROP COLUMN IF EXISTS operational_status;
ALTER TABLE public.assets
    DROP COLUMN IF EXISTS tech_type;
ALTER TABLE public.assets
    DROP COLUMN IF EXISTS asset_category;
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
