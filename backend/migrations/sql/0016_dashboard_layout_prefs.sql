-- SISPAT-AGU - user_preferences.dashboard_layout (layout do dashboard)
--
-- APLICADA manualmente no Supabase em 2026-10-21, com autorização explícita,
-- via este espelho (SQL Editor); no deploy usar
-- `alembic stamp 0013_dashboard_layout_prefs` (sem upgrade).
--
-- Espelha a migração Alembic
-- backend/migrations/versions/0013_dashboard_layout_prefs.py -- o teste
-- backend/tests/test_db_static.py verifica que cada bloco do upgrade está
-- presente aqui. Qualquer alteração deve ser feita nos dois arquivos.
--
-- Pré-requisito: 0015_asset_bond_status.sql (Alembic 0012) e a tabela
-- user_preferences (0007_settings_ai_users.sql). RLS/REVOKE da tabela já
-- vêm da 0007 (nenhuma tabela nova aqui).
-- Aditivo e idempotente. Sem BEGIN/COMMIT (SQL Editor do Supabase).
-- Downgrade: ver DOWNGRADE_SQL na migração Alembic correspondente.

ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS dashboard_layout jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_user_preferences_dashboard_layout_object'
          AND conrelid = 'public.user_preferences'::regclass
    ) THEN
        ALTER TABLE public.user_preferences
            ADD CONSTRAINT ck_user_preferences_dashboard_layout_object
            CHECK (jsonb_typeof(dashboard_layout) = 'object');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_user_preferences_dashboard_layout_size'
          AND conrelid = 'public.user_preferences'::regclass
    ) THEN
        ALTER TABLE public.user_preferences
            ADD CONSTRAINT ck_user_preferences_dashboard_layout_size
            CHECK (octet_length(dashboard_layout::text) <= 1024);
    END IF;
END
$do$;
