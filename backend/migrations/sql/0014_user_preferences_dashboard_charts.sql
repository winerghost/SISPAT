-- SISPAT-AGU - user_preferences.dashboard_charts (gráficos do dashboard)
--
-- APLICADO manualmente no Supabase (projeto único) em 2026-10-19, com
-- autorização explícita, pelo SQL Editor.
--
-- Espelha a migração Alembic
-- backend/migrations/versions/0011_user_preferences_dashboard_charts.py -- o
-- teste backend/tests/test_db_static.py verifica que cada bloco do upgrade
-- está presente aqui. Qualquer alteração deve ser feita nos dois arquivos.
--
-- Pré-requisito: 0013_seed_permission_corrections.sql (Alembic 0010) e a
-- tabela user_preferences (0007_settings_ai_users.sql).
-- Aditivo e idempotente. Sem BEGIN/COMMIT (SQL Editor do Supabase).
-- Downgrade: ver DOWNGRADE_SQL na migração Alembic correspondente.

ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS dashboard_charts jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_user_preferences_dashboard_charts_object'
          AND conrelid = 'public.user_preferences'::regclass
    ) THEN
        ALTER TABLE public.user_preferences
            ADD CONSTRAINT ck_user_preferences_dashboard_charts_object
            CHECK (jsonb_typeof(dashboard_charts) = 'object');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_user_preferences_dashboard_charts_size'
          AND conrelid = 'public.user_preferences'::regclass
    ) THEN
        ALTER TABLE public.user_preferences
            ADD CONSTRAINT ck_user_preferences_dashboard_charts_size
            CHECK (octet_length(dashboard_charts::text) <= 512);
    END IF;
END
$do$;
