-- SISPAT-AGU - assets: classificação de bens de TI
--
-- PENDENTE DE APLICAÇÃO: NÃO executar em banco algum sem autorização
-- explícita (o Supabase é único: dev = prod). Quando autorizada, rodar este
-- espelho no SQL Editor e, no deploy, usar
-- `alembic stamp 0015_asset_tech_classification` (sem upgrade).
--
-- Espelha a migração Alembic
-- backend/migrations/versions/0015_asset_tech_classification.py -- o teste
-- backend/tests/test_db_static.py verifica que cada bloco do upgrade está
-- presente aqui. Qualquer alteração deve ser feita nos dois arquivos.
--
-- Colunas SEM default: NULL = "não informado". Sem backfill: a classificação
-- inicial é o comando `flask classify-assets` (dry-run por padrão).
--
-- Pré-requisito: 0017_unaccent_search.sql (Alembic 0014). Tabela existente:
-- RLS/REVOKE já vêm da 0006 (nenhuma tabela nova aqui).
-- Aditivo e idempotente. Sem BEGIN/COMMIT (SQL Editor do Supabase).
-- Downgrade: ver DOWNGRADE_SQL na migração Alembic correspondente.

ALTER TABLE public.assets
    ADD COLUMN IF NOT EXISTS asset_category text NULL,
    ADD COLUMN IF NOT EXISTS tech_type text NULL,
    ADD COLUMN IF NOT EXISTS operational_status text NULL;

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

CREATE INDEX IF NOT EXISTS ix_assets_category_active
    ON public.assets (asset_category, tech_type, unit_id)
    WHERE deleted_at IS NULL AND asset_category IS NOT NULL;
