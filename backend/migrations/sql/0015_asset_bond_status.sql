-- SISPAT-AGU - assets.bond_status (campo "Vínculo" do bem)
--
-- APLICADA manualmente no Supabase (projeto único) em 2026-10-20, com
-- autorização explícita, pelo SQL Editor. No deploy, usar
-- `alembic stamp 0012_asset_bond_status` (sem upgrade).
--
-- Espelha a migração Alembic
-- backend/migrations/versions/0012_asset_bond_status.py -- o teste
-- backend/tests/test_db_static.py verifica que cada bloco do upgrade está
-- presente aqui. Qualquer alteração deve ser feita nos dois arquivos.
--
-- Valor da 1ª coluna RESPONSAVEL da planilha (ex.: Servidor, Terceirizado,
-- Ocioso), hoje só em raw_import_records.normalized_values->>'vinculo_situacao'.
-- Backfill a partir do registro IMPORTADO mais recente do mesmo
-- source_record_id (origem google_sheets), só onde bond_status IS NULL;
-- normalizado e truncado em 64 caracteres para respeitar o CHECK.
--
-- Pré-requisito: 0014_user_preferences_dashboard_charts.sql (Alembic 0011).
-- Aditivo e idempotente. Sem BEGIN/COMMIT (SQL Editor do Supabase).
-- Downgrade: ver DOWNGRADE_SQL na migração Alembic correspondente.

ALTER TABLE public.assets
    ADD COLUMN IF NOT EXISTS bond_status text NULL;

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

CREATE INDEX IF NOT EXISTS ix_assets_bond_status_lower
    ON public.assets (lower(bond_status)) WHERE deleted_at IS NULL;

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
