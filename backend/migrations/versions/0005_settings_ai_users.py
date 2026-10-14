"""configurações de IA, preferências de usuário e colunas de gestão de usuários

PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. Esta migração NÃO foi
aplicada em banco algum (nem Supabase de produção, projeto
tocbtonqnahmtegfkrmn). Depende de 0004_db_security_hardening, que também
está pendente em produção (DB-02).

O que faz (aditivo e idempotente -- nenhuma tabela, coluna ou linha
preexistente é removida ou alterada):

1. `ai_settings`: linha ÚNICA (id = 1, garantido por CHECK) com a
   configuração de IA editável pelo ADM: `enabled`, `provider`
   (none/openai/anthropic/deepseek), `model`, `features` (JSONB; chaves
   validadas no backend), aceite de transferência internacional do DeepSeek
   (`deepseek_acknowledged_at/by`), `monthly_token_cap`, `version` (controle
   otimista), `updated_by` e timestamps. Nenhuma CHAVE de API é armazenada
   aqui: chaves vivem só em variáveis de ambiente do backend.
   A linha padrão nasce DESLIGADA (enabled=false, provider='none').
2. `user_preferences`: preferências de aparência por usuário (`density`
   comfortable/compact, `font_scale` 100/112/125), `version` e timestamps.
3. `users`: colunas aditivas `version` (default 1), `sessions_revoked_at`,
   `avatar_object_key`, `deactivated_at`, `deactivated_by`.
4. RLS habilitado SEM políticas (deny-all para quem não tem BYPASSRLS) e
   REVOKE de anon/authenticated nas tabelas novas (padrão da 0004). Os
   blocos que dependem das roles do Supabase são condicionais à existência
   delas, de modo que a migração também roda em um Postgres local puro.
5. Seed idempotente de permissões novas, vinculadas EXCLUSIVAMENTE ao ADM:
   settings.ai.manage, ai.use, users.reset_password, users.reset_mfa,
   users.revoke_sessions, users.avatar.manage.

Espelho SQL: backend/migrations/sql/0007_settings_ai_users.sql (verificado
por backend/tests/test_db_static.py).

Downgrade: remove apenas o que esta migração criou (as duas tabelas novas e
as cinco colunas novas de `users`). Nenhum dado preexistente à migração é
afetado. As permissões semeadas são mantidas (inofensivas sem código que as
use; removê-las apagaria vínculos que um ADM possa ter ajustado).

Revision ID: 0005_settings_ai_users
Revises: 0004_db_security_hardening
Create Date: 2026-10-14

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

# revisão Alembic, identificadores usados por Alembic.
revision: str = "0005_settings_ai_users"
down_revision: Union[str, None] = "0004_db_security_hardening"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None


# Tabelas criadas por esta migração (RLS + REVOKE aplicados a todas).
NEW_TABLES: tuple[str, ...] = ("ai_settings", "user_preferences")

# Permissões novas (somente ADM).
NEW_PERMISSIONS: tuple[str, ...] = (
    "settings.ai.manage",
    "ai.use",
    "users.reset_password",
    "users.reset_mfa",
    "users.revoke_sessions",
    "users.avatar.manage",
)

CREATE_AI_SETTINGS_SQL = """
CREATE TABLE IF NOT EXISTS public.ai_settings (
    id smallint PRIMARY KEY DEFAULT 1,
    enabled boolean NOT NULL DEFAULT false,
    provider text NOT NULL DEFAULT 'none',
    model text NULL,
    features jsonb NOT NULL DEFAULT '{}'::jsonb,
    deepseek_acknowledged_at timestamptz NULL,
    deepseek_acknowledged_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
    monthly_token_cap integer NOT NULL DEFAULT 200000,
    version integer NOT NULL DEFAULT 1,
    updated_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_ai_settings_singleton CHECK (id = 1),
    CONSTRAINT ck_ai_settings_provider CHECK (provider IN ('none','openai','anthropic','deepseek')),
    CONSTRAINT ck_ai_settings_model_length CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 100),
    CONSTRAINT ck_ai_settings_features_object CHECK (jsonb_typeof(features) = 'object'),
    CONSTRAINT ck_ai_settings_token_cap CHECK (monthly_token_cap BETWEEN 0 AND 50000000),
    CONSTRAINT ck_ai_settings_version CHECK (version >= 1),
    CONSTRAINT ck_ai_settings_deepseek_ack CHECK (provider <> 'deepseek' OR deepseek_acknowledged_at IS NOT NULL)
);

COMMENT ON TABLE public.ai_settings IS
    'Configuracao de IA (linha unica id=1). NUNCA armazena chaves de API: chaves ficam so no ambiente do backend.';
"""

SEED_AI_SETTINGS_SQL = """
INSERT INTO public.ai_settings (id, enabled, provider, model, features)
VALUES (
    1, false, 'none', NULL,
    '{"alerts_explain": false, "executive_summary": false, "assistant": false, "data_quality": false}'::jsonb
)
ON CONFLICT (id) DO NOTHING;
"""

CREATE_USER_PREFERENCES_SQL = """
CREATE TABLE IF NOT EXISTS public.user_preferences (
    user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    density text NOT NULL DEFAULT 'comfortable',
    font_scale smallint NOT NULL DEFAULT 100,
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_user_preferences_density CHECK (density IN ('comfortable','compact')),
    CONSTRAINT ck_user_preferences_font_scale CHECK (font_scale IN (100, 112, 125)),
    CONSTRAINT ck_user_preferences_version CHECK (version >= 1)
);

COMMENT ON TABLE public.user_preferences IS
    'Preferencias de aparencia por usuario (densidade e escala de fonte). Tema unico: Factory dark.';
"""

ALTER_USERS_SQL = """
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS sessions_revoked_at timestamptz NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_object_key text NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deactivated_at timestamptz NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deactivated_by uuid NULL
    REFERENCES public.users(id) ON DELETE SET NULL;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_users_version_positive'
          AND conrelid = 'public.users'::regclass
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT ck_users_version_positive CHECK (version >= 1);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_users_avatar_object_key_length'
          AND conrelid = 'public.users'::regclass
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT ck_users_avatar_object_key_length
            CHECK (avatar_object_key IS NULL OR char_length(avatar_object_key) BETWEEN 1 AND 200);
    END IF;
END
$do$;
"""

ENABLE_RLS_NEW_TABLES_SQL = """
ALTER TABLE public.ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
"""

REVOKE_API_ROLES_NEW_TABLES_SQL = """
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public.ai_settings FROM anon, authenticated;
        REVOKE ALL ON TABLE public.user_preferences FROM anon, authenticated;
    END IF;
END
$do$;
"""

SEED_PERMISSIONS_SQL = """
INSERT INTO public.permissions (code, description, resource, action) VALUES
    ('settings.ai.manage',    'Gerenciar a configuracao de IA (provedor, modelo, funcionalidades).', 'settings', 'ai.manage'),
    ('ai.use',                'Usar funcionalidades consultivas de IA.',                            'ai',       'use'),
    ('users.reset_password',  'Disparar redefinicao de senha de um usuario.',                       'users',    'reset_password'),
    ('users.reset_mfa',       'Redefinir os fatores MFA de um usuario (exige reautenticacao).',     'users',    'reset_mfa'),
    ('users.revoke_sessions', 'Encerrar as sessoes ativas de um usuario.',                          'users',    'revoke_sessions'),
    ('users.avatar.manage',   'Gerenciar a foto de perfil de outros usuarios.',                     'users',    'avatar.manage')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.code IN (
    'settings.ai.manage',
    'ai.use',
    'users.reset_password',
    'users.reset_mfa',
    'users.revoke_sessions',
    'users.avatar.manage'
)
WHERE r.code = 'ADM'
ON CONFLICT (role_id, permission_id) DO NOTHING;
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (
    CREATE_AI_SETTINGS_SQL,
    SEED_AI_SETTINGS_SQL,
    CREATE_USER_PREFERENCES_SQL,
    ALTER_USERS_SQL,
    ENABLE_RLS_NEW_TABLES_SQL,
    REVOKE_API_ROLES_NEW_TABLES_SQL,
    SEED_PERMISSIONS_SQL,
)


# ---------------------------------------------------------------------------
# downgrade: remove SOMENTE objetos criados por esta migração. Nenhum dado
# preexistente é afetado. Permissões semeadas são mantidas (ver docstring).
# ---------------------------------------------------------------------------
DOWNGRADE_SQL = """
DROP TABLE IF EXISTS public.user_preferences;
DROP TABLE IF EXISTS public.ai_settings;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS ck_users_avatar_object_key_length;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS ck_users_version_positive;
ALTER TABLE public.users DROP COLUMN IF EXISTS deactivated_by;
ALTER TABLE public.users DROP COLUMN IF EXISTS deactivated_at;
ALTER TABLE public.users DROP COLUMN IF EXISTS avatar_object_key;
ALTER TABLE public.users DROP COLUMN IF EXISTS sessions_revoked_at;
ALTER TABLE public.users DROP COLUMN IF EXISTS version;
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
