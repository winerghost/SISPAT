-- SISPAT-AGU - Configurações de IA, preferências de usuário e gestão de usuários
--
-- PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. NÃO aplicado em banco
-- algum (nem no Supabase de produção, tocbtonqnahmtegfkrmn).
--
-- Este arquivo espelha EXATAMENTE (gerado a partir de) a migração Alembic
-- backend/migrations/versions/0005_settings_ai_users.py -- o teste
-- backend/tests/test_db_static.py verifica que cada bloco do upgrade está
-- presente aqui. Qualquer alteração deve ser feita nos dois arquivos.
--
-- Pré-requisitos: 0001..0006 (Alembic 0001..0004), em especial
-- 0006_db_security_hardening.sql (Alembic 0004), também pendente (DB-02).
-- Idempotente: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
-- ON CONFLICT DO NOTHING / constraints protegidas por verificação prévia.
-- Não destrutivo: nenhuma tabela, coluna ou linha preexistente é removida.
-- Nenhuma chave de API é armazenada no banco (só no ambiente do backend).
-- Downgrade: ver DOWNGRADE_SQL na migração Alembic correspondente.

BEGIN;

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

INSERT INTO public.ai_settings (id, enabled, provider, model, features)
VALUES (
    1, false, 'none', NULL,
    '{"alerts_explain": false, "executive_summary": false, "assistant": false, "data_quality": false}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

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

ALTER TABLE public.ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public.ai_settings FROM anon, authenticated;
        REVOKE ALL ON TABLE public.user_preferences FROM anon, authenticated;
    END IF;
END
$do$;

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

COMMIT;
