-- SISPAT-AGU - Hardening de segurança do banco (auditoria 2026-10-13)
--
-- PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. NÃO aplicado no
-- Supabase de produção (tocbtonqnahmtegfkrmn).
--
-- Este arquivo espelha EXATAMENTE (gerado a partir de) a migração Alembic
-- backend/migrations/versions/0004_db_security_hardening.py -- o teste
-- backend/tests/test_db_static.py verifica que cada bloco do upgrade está
-- presente aqui. Qualquer alteração deve ser feita nos dois arquivos.
--
-- Pré-requisitos: 0001_initial_schema, 0003_import_previews.sql e
-- 0004_invites.sql (Alembic 0002/0003). Tabelas ausentes são ignoradas.
-- Idempotente: pode ser reexecutado sem erro e sem efeito adicional.
-- Não destrutivo: nenhuma tabela, coluna ou linha é removida.
-- Downgrade: ver DOWNGRADE_SQL na migração Alembic correspondente.

BEGIN;

CREATE OR REPLACE FUNCTION public.sispat_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
    RAISE EXCEPTION 'SISPAT-AGU: operacao % proibida em %.% (%)',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME,
        COALESCE(TG_ARGV[0], 'tabela protegida')
        USING ERRCODE = '42501';
    RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION public.sispat_block_mutation() IS
    'Trigger function: rejeita UPDATE/DELETE/TRUNCATE proibidos (audit_logs append-only; exclusao patrimonial apenas logica).';

REVOKE ALL ON FUNCTION public.sispat_block_mutation() FROM PUBLIC;

CREATE OR REPLACE TRIGGER trg_audit_logs_block_update_delete
    BEFORE UPDATE OR DELETE ON public.audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION public.sispat_block_mutation('audit_logs e append-only');

CREATE OR REPLACE TRIGGER trg_audit_logs_block_truncate
    BEFORE TRUNCATE ON public.audit_logs
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.sispat_block_mutation('audit_logs e append-only');

DO $do$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['assets', 'asset_movements', 'raw_import_records'] LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format(
                'CREATE OR REPLACE TRIGGER %I BEFORE DELETE ON public.%I '
                'FOR EACH ROW EXECUTE FUNCTION public.sispat_block_mutation(%L)',
                'trg_' || t || '_block_delete', t,
                'exclusao fisica proibida; use exclusao logica'
            );
            EXECUTE format(
                'CREATE OR REPLACE TRIGGER %I BEFORE TRUNCATE ON public.%I '
                'FOR EACH STATEMENT EXECUTE FUNCTION public.sispat_block_mutation(%L)',
                'trg_' || t || '_block_truncate', t,
                'exclusao fisica proibida; use exclusao logica'
            );
        END IF;
    END LOOP;
END
$do$;

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
        REVOKE EXECUTE ON FUNCTION public.sispat_block_mutation() FROM anon, authenticated;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
            ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
                REVOKE ALL ON TABLES FROM anon, authenticated;
            ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
                REVOKE ALL ON SEQUENCES FROM anon, authenticated;
            ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
                REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM service_role;
        REVOKE EXECUTE ON FUNCTION public.sispat_block_mutation() FROM service_role;
    END IF;
END
$do$;

DO $do$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['users', 'roles', 'permissions', 'role_permissions', 'user_roles', 'units', 'user_unit_access', 'rooms', 'locations', 'responsible_people', 'assets', 'asset_movements', 'inventories', 'inventory_items', 'audit_logs', 'sync_jobs', 'sync_conflicts', 'raw_import_records', 'saved_filters', 'export_jobs', 'import_previews', 'import_preview_items', 'invites', 'invite_units'] LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        END IF;
    END LOOP;
END
$do$;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_deleted_by_required'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_deleted_by_required
            CHECK (deleted_at IS NULL OR deleted_by IS NOT NULL) NOT VALID;
        ALTER TABLE public.assets
            VALIDATE CONSTRAINT ck_assets_deleted_by_required;
    END IF;
END
$do$;

COMMIT;
