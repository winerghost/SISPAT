"""assets: classificação família/categoria (motor determinístico) + override do ADM

DDL APLICADO NO SUPABASE EM 2026-10-27 (autorizado pelo usuário, pelo espelho
`sql/0021_equipment_classification.sql` no SQL Editor). O `alembic_version`
ainda NÃO foi carimbado: quem implanta roda
`alembic stamp 0018_equipment_classification` (SEM upgrade — o DDL já está no
banco; o upgrade é idempotente, mas não deve ser executado em produção sem
autorização). Nenhum backfill foi feito: as colunas estão todas NULL.

O DDL está CONGELADO: nomes/tipos de coluna, nomes e expressões dos CHECKs e o
nome do índice existem no banco e não podem mais ser alterados aqui.

Depende de 0017_dashboard_panel_prefs (a cadeia Alembic é linear).

Rollback: `alembic downgrade 0017_dashboard_panel_prefs` (ou o DOWNGRADE_SQL
abaixo no SQL Editor) — remove só o índice, os CHECKs e as colunas criados
aqui; perde apenas a classificação (dados do bem intactos).

Contexto: o motor `app.services.asset_classification.classify_equipment`
classifica a descrição do bem em família (TI/MOBILIARIO/OUTROS), categoria
(20 valores), confiança (ALTA/BAIXA) e registra QUAL regra decidiu
(`classification_rule`) com qual versão do conjunto de regras
(`classification_rules_version` = `RULES_VERSION`). O vocabulário legado da
0015 (`asset_category`/`tech_type`) continua existindo e NÃO é alterado.

Aditiva, idempotente e sem backfill (a classificação inicial é o comando
`flask classify-equipment`, dry-run por padrão; nunca executado com --apply
contra o Supabase):
- colunas `equipment_family`, `equipment_category`,
  `classification_confidence`, `classification_rule`,
  `classification_rules_version` e `category_override` (text NULL, SEM
  default: NULL = "não informado", nunca um valor fictício);
- CHECK `ck_assets_equipment_family` (TI/MOBILIARIO/OUTROS);
- CHECK `ck_assets_equipment_category` (categoria só com a família a que
  pertence);
- CHECK `ck_assets_classification_confidence` (ALTA/BAIXA);
- CHECK `ck_assets_category_override` (qualquer das 20 categorias: o override
  do ADM prevalece sobre a regra e o motor nunca escreve nesta coluna);
- CHECKs de tamanho de `classification_rule` (<= 64) e
  `classification_rules_version` (<= 16), sem espaços nas pontas;
- índice parcial `ix_assets_equipment_active` (bens ativos já classificados).
As tuplas dos CHECKs espelham `app.services.asset_classification`
(`EQUIPMENT_FAMILIES`, `TI_CATEGORIES`, `MOBILIARIO_CATEGORIES`,
`OUTROS_CATEGORIES`, `EQUIPMENT_CATEGORIES`, `CLASSIFICATION_CONFIDENCES`) e um
teste garante a igualdade (backend/tests/test_asset_classification_migration.py).

Tabela existente: RLS/REVOKE já vêm da 0004 (nenhuma tabela nova aqui).

Espelho SQL: backend/migrations/sql/0021_equipment_classification.sql
(pré-requisito: 0020_dashboard_panel_prefs.sql, que é o Alembic 0017).

Revision ID: 0018_equipment_classification
Revises: 0017_dashboard_panel_prefs
Create Date: 2026-10-27
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0018_equipment_classification"
down_revision: Union[str, None] = "0017_dashboard_panel_prefs"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

ADD_COLUMNS_SQL = """
ALTER TABLE public.assets
    ADD COLUMN IF NOT EXISTS equipment_family text NULL,
    ADD COLUMN IF NOT EXISTS equipment_category text NULL,
    ADD COLUMN IF NOT EXISTS classification_confidence text NULL,
    ADD COLUMN IF NOT EXISTS classification_rule text NULL,
    ADD COLUMN IF NOT EXISTS classification_rules_version text NULL,
    ADD COLUMN IF NOT EXISTS category_override text NULL;
"""

ADD_CHECKS_SQL = """
DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_equipment_family'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_equipment_family
            CHECK (equipment_family IS NULL OR equipment_family IN ('TI','MOBILIARIO','OUTROS'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_equipment_category'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_equipment_category
            CHECK (equipment_category IS NULL OR ((equipment_family = 'TI' AND equipment_category IN ('COMPUTADOR','NOTEBOOK','MONITOR','IMPRESSORA','NOBREAK','ESTABILIZADOR','DOCKING','REDE','OUTRO_TI')) OR (equipment_family = 'MOBILIARIO' AND equipment_category IN ('MESA','ARMARIO','GAVETEIRO','ESTACAO_TRABALHO','CADEIRA','POLTRONA','SOFA','ESTANTE','OUTRO_MOB')) OR (equipment_family = 'OUTROS' AND equipment_category IN ('EQUIPAMENTO','OUTROS'))));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_classification_confidence'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_classification_confidence
            CHECK (classification_confidence IS NULL OR classification_confidence IN ('ALTA','BAIXA'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_category_override'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_category_override
            CHECK (category_override IS NULL OR category_override IN ('COMPUTADOR','NOTEBOOK','MONITOR','IMPRESSORA','NOBREAK','ESTABILIZADOR','DOCKING','REDE','OUTRO_TI','MESA','ARMARIO','GAVETEIRO','ESTACAO_TRABALHO','CADEIRA','POLTRONA','SOFA','ESTANTE','OUTRO_MOB','EQUIPAMENTO','OUTROS'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_classification_rule_len'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_classification_rule_len
            CHECK (classification_rule IS NULL OR (char_length(classification_rule) BETWEEN 1 AND 64 AND classification_rule = btrim(classification_rule)));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_classification_rules_version_len'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_classification_rules_version_len
            CHECK (classification_rules_version IS NULL OR (char_length(classification_rules_version) BETWEEN 1 AND 16 AND classification_rules_version = btrim(classification_rules_version)));
    END IF;
END
$do$;
"""

CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS ix_assets_equipment_active
    ON public.assets (equipment_family, equipment_category, unit_id)
    WHERE deleted_at IS NULL AND equipment_category IS NOT NULL;
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (ADD_COLUMNS_SQL, ADD_CHECKS_SQL, CREATE_INDEX_SQL)

DOWNGRADE_SQL = """
DROP INDEX IF EXISTS public.ix_assets_equipment_active;
ALTER TABLE public.assets
    DROP CONSTRAINT IF EXISTS ck_assets_classification_rules_version_len;
ALTER TABLE public.assets
    DROP CONSTRAINT IF EXISTS ck_assets_classification_rule_len;
ALTER TABLE public.assets
    DROP CONSTRAINT IF EXISTS ck_assets_category_override;
ALTER TABLE public.assets
    DROP CONSTRAINT IF EXISTS ck_assets_classification_confidence;
ALTER TABLE public.assets
    DROP CONSTRAINT IF EXISTS ck_assets_equipment_category;
ALTER TABLE public.assets
    DROP CONSTRAINT IF EXISTS ck_assets_equipment_family;
ALTER TABLE public.assets
    DROP COLUMN IF EXISTS category_override;
ALTER TABLE public.assets
    DROP COLUMN IF EXISTS classification_rules_version;
ALTER TABLE public.assets
    DROP COLUMN IF EXISTS classification_rule;
ALTER TABLE public.assets
    DROP COLUMN IF EXISTS classification_confidence;
ALTER TABLE public.assets
    DROP COLUMN IF EXISTS equipment_category;
ALTER TABLE public.assets
    DROP COLUMN IF EXISTS equipment_family;
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
