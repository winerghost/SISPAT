"""hardening de segurança do banco (auditoria 2026-10-13)

PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. Esta migração foi
criada pela auditoria de banco de dados, mas NÃO foi aplicada no Supabase de
produção (projeto tocbtonqnahmtegfkrmn). Ver docs/security/evidence/database.md.

O que faz (tudo não destrutivo e idempotente -- nenhuma tabela, coluna ou
linha é removida):

1. Função `public.sispat_block_mutation()` (SECURITY INVOKER, search_path
   vazio) usada por triggers que rejeitam operações proibidas pelo
   CLAUDE.md com SQLSTATE 42501.
2. `audit_logs` append-only: triggers bloqueiam UPDATE, DELETE e TRUNCATE;
   REVOKE de UPDATE/DELETE/TRUNCATE para anon/authenticated/service_role.
3. Exclusão física proibida em `assets`, `asset_movements` e
   `raw_import_records` (triggers BEFORE DELETE e BEFORE TRUNCATE). Isso
   também neutraliza o efeito dos FKs `ON DELETE CASCADE` que apagariam o
   histórico de movimentações/inventário ao remover um bem.
4. REVOKE ALL das roles `anon`/`authenticated` (Data API/PostgREST) sobre
   tabelas, sequências e funções do schema `public`, e sobre os privilégios
   padrão (default privileges) concedidos pelo role `postgres` -- o navegador
   nunca deve acessar tabelas patrimoniais (CLAUDE.md > Arquitetura). Note
   que TRUNCATE/TRIGGER/REFERENCES não são cobertos por RLS.
5. ENABLE ROW LEVEL SECURITY (sem políticas = deny-all para quem não tem
   BYPASSRLS) em todas as tabelas de aplicação existentes, inclusive as
   criadas por 0002_import_previews e 0003_invites, que hoje NÃO têm RLS
   versionado (drift: o RLS de produção foi aplicado fora do repositório).
6. CHECK `ck_assets_deleted_by_required` (deleted_at IS NULL OR deleted_by
   IS NOT NULL) previsto em docs/database/modelo-logico.md e ausente.

Blocos que dependem das roles do Supabase (`anon`, `authenticated`,
`service_role`, `postgres`) são condicionais à existência dessas roles, de
modo que a migração também roda em um Postgres local puro.

Consequência operacional documentada: com audit_logs imutável, um DELETE
físico em `users` passa a falhar (o FK `audit_logs.actor_user_id ON DELETE
SET NULL` tentaria um UPDATE em audit_logs). Isso é intencional: usuários
são desativados (`users.active = false`), nunca apagados.

Revision ID: 0004_db_security_hardening
Revises: 0003_invites
Create Date: 2026-10-13

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

# revisão Alembic, identificadores usados por Alembic.
revision: str = "0004_db_security_hardening"
down_revision: Union[str, None] = "0003_invites"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None


# Todas as tabelas de aplicação conhecidas (0001 + 0002 + 0003). Tabelas
# inexistentes no banco alvo são ignoradas (to_regclass IS NULL).
APP_TABLES: tuple[str, ...] = (
    "users",
    "roles",
    "permissions",
    "role_permissions",
    "user_roles",
    "units",
    "user_unit_access",
    "rooms",
    "locations",
    "responsible_people",
    "assets",
    "asset_movements",
    "inventories",
    "inventory_items",
    "audit_logs",
    "sync_jobs",
    "sync_conflicts",
    "raw_import_records",
    "saved_filters",
    "export_jobs",
    "import_previews",
    "import_preview_items",
    "invites",
    "invite_units",
)

# Tabelas cujo DELETE/TRUNCATE físico é proibido (histórico patrimonial).
NO_PHYSICAL_DELETE_TABLES: tuple[str, ...] = (
    "assets",
    "asset_movements",
    "raw_import_records",
)


def _sql_text_array(names: Sequence[str]) -> str:
    """Literal SQL `ARRAY['a', 'b']` a partir de identificadores fixos do código."""
    return "ARRAY[" + ", ".join(f"'{name}'" for name in names) + "]"


_NO_DELETE_ARRAY = _sql_text_array(NO_PHYSICAL_DELETE_TABLES)
_APP_TABLES_ARRAY = _sql_text_array(APP_TABLES)

BLOCK_FUNCTION_SQL = """
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
"""

AUDIT_LOGS_TRIGGERS_SQL = """
CREATE OR REPLACE TRIGGER trg_audit_logs_block_update_delete
    BEFORE UPDATE OR DELETE ON public.audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION public.sispat_block_mutation('audit_logs e append-only');

CREATE OR REPLACE TRIGGER trg_audit_logs_block_truncate
    BEFORE TRUNCATE ON public.audit_logs
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.sispat_block_mutation('audit_logs e append-only');
"""

NO_DELETE_TRIGGERS_SQL = """
DO $do$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY __NO_DELETE_ARRAY__ LOOP
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
""".replace("__NO_DELETE_ARRAY__", _NO_DELETE_ARRAY)

REVOKE_API_ROLES_SQL = """
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
"""

ENABLE_RLS_SQL = """
DO $do$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY __APP_TABLES_ARRAY__ LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        END IF;
    END LOOP;
END
$do$;
""".replace("__APP_TABLES_ARRAY__", _APP_TABLES_ARRAY)

ASSETS_DELETED_BY_CHECK_SQL = """
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
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (
    BLOCK_FUNCTION_SQL,
    AUDIT_LOGS_TRIGGERS_SQL,
    NO_DELETE_TRIGGERS_SQL,
    REVOKE_API_ROLES_SQL,
    ENABLE_RLS_SQL,
    ASSETS_DELETED_BY_CHECK_SQL,
)


# ---------------------------------------------------------------------------
# downgrade: restaura exatamente o estado observado em produção antes desta
# migração (grants amplos a anon/authenticated, sem triggers, sem CHECK).
# O RLS NÃO é desabilitado no downgrade: ele já existia em produção antes
# desta migração (aplicado fora do repositório) e desligá-lo seria fail-open.
# ---------------------------------------------------------------------------
DOWNGRADE_SQL = """
ALTER TABLE public.assets DROP CONSTRAINT IF EXISTS ck_assets_deleted_by_required;

DO $do$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY __NO_DELETE_ARRAY__ LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_' || t || '_block_delete', t);
            EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_' || t || '_block_truncate', t);
        END IF;
    END LOOP;
END
$do$;

DROP TRIGGER IF EXISTS trg_audit_logs_block_update_delete ON public.audit_logs;
DROP TRIGGER IF EXISTS trg_audit_logs_block_truncate ON public.audit_logs;
DROP FUNCTION IF EXISTS public.sispat_block_mutation();

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
        GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
            ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
                GRANT ALL ON TABLES TO anon, authenticated;
            ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
                GRANT ALL ON SEQUENCES TO anon, authenticated;
            ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
                GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
        END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT UPDATE, DELETE, TRUNCATE ON public.audit_logs TO service_role;
    END IF;
END
$do$;
""".replace("__NO_DELETE_ARRAY__", _NO_DELETE_ARRAY)


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
