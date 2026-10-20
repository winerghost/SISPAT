"""assets.bond_status (campo "Vínculo" do bem)

APLICADA manualmente no Supabase (projeto único) em 2026-10-20, com
autorização explícita, via o espelho sql/0015 no SQL Editor; no deploy usar
`alembic stamp 0012_asset_bond_status` (sem upgrade). Depende de
0011_dashboard_charts_prefs (a cadeia Alembic é linear).

Contexto: a 1ª coluna `RESPONSAVEL` da planilha (Google Sheets) traz o
vínculo/situação do bem (ex.: "Servidor", "Terceirizado", "Ocioso"). Até
aqui o valor só existia em `raw_import_records.normalized_values->>
'vinculo_situacao'` (e em `import_preview_items.normalized_values`). Esta
migração o materializa em `assets.bond_status` para exibição e filtro; a
coluna é gerenciada pela importação.

Aditiva e idempotente:
- coluna `bond_status text NULL` (sem default);
- CHECK `ck_assets_bond_status_len`: NULL ou 1..64 caracteres, sem espaços
  nas pontas;
- índice parcial `ix_assets_bond_status_lower` (lower(bond_status)) para
  filtro em bens ativos;
- backfill só onde `bond_status IS NULL`, a partir do registro bruto MAIS
  RECENTE (`created_at DESC, id DESC`) com `import_status = 'IMPORTADO'` do
  mesmo `source_record_id`, restrito à origem `google_sheets` (sync_jobs.source
  e assets.source_system). O valor é normalizado (espaços colapsados,
  truncado em 64 caracteres, btrim por último) para respeitar o CHECK; vazio
  vira NULL (não grava). Reexecutar não altera linhas já preenchidas.
  O backfill não incrementa `assets.version` (executa fora da aplicação, sem
  edição concorrente) e não altera dados patrimoniais existentes.

Espelho SQL: backend/migrations/sql/0015_asset_bond_status.sql.

Downgrade: remove índice, CHECK e coluna (perde só este campo; o valor de
origem continua em raw_import_records).

Revision ID: 0012_asset_bond_status
Revises: 0011_dashboard_charts_prefs
Create Date: 2026-10-20

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0012_asset_bond_status"
down_revision: Union[str, None] = "0011_dashboard_charts_prefs"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

BOND_STATUS_MAX_LEN = 64

ADD_COLUMN_SQL = """
ALTER TABLE public.assets
    ADD COLUMN IF NOT EXISTS bond_status text NULL;
"""

ADD_CHECK_SQL = """
DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_bond_status_len'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_bond_status_len
            CHECK (bond_status IS NULL OR (char_length(bond_status) BETWEEN 1 AND 64 AND bond_status = btrim(bond_status)));
    END IF;
END
$do$;
"""

CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS ix_assets_bond_status_lower
    ON public.assets (lower(bond_status)) WHERE deleted_at IS NULL;
"""

# Raw string: `\s` é a classe de espaço da regex do Postgres (não escape Python).
BACKFILL_SQL = r"""
UPDATE public.assets a
SET bond_status = v.bond
FROM (
    SELECT DISTINCT ON (r.source_record_id)
        r.source_record_id,
        NULLIF(btrim(left(regexp_replace(btrim(r.normalized_values->>'vinculo_situacao'), '\s+', ' ', 'g'), 64)), '') AS bond
    FROM public.raw_import_records r
    JOIN public.sync_jobs j ON j.id = r.sync_job_id
    WHERE r.import_status = 'IMPORTADO'
      AND j.source = 'google_sheets'
    ORDER BY r.source_record_id, r.created_at DESC, r.id DESC
) v
WHERE a.source_record_id = v.source_record_id
  AND a.source_system = 'google_sheets'
  AND a.bond_status IS NULL
  AND v.bond IS NOT NULL;
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (
    ADD_COLUMN_SQL,
    ADD_CHECK_SQL,
    CREATE_INDEX_SQL,
    BACKFILL_SQL,
)

DOWNGRADE_SQL = """
DROP INDEX IF EXISTS public.ix_assets_bond_status_lower;
ALTER TABLE public.assets
    DROP CONSTRAINT IF EXISTS ck_assets_bond_status_len;
ALTER TABLE public.assets
    DROP COLUMN IF EXISTS bond_status;
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
